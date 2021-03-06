const fs = require('fs');
const promiseTimeout = require('promise-timeout').timeout;
const sleep = require('sleep-promise');
const fetch = require('node-fetch');
const homoglyphSearch = require('homoglyph-search').search;
const Discord = require('discord.js');
const client = new Discord.Client();

const prices = require('./prices.js');

const config = require('../config.json');

let muted = {};

try {
    muted = JSON.parse(fs.readFileSync('muted.json'));
} catch (err) {
    console.error('Failed to read muted data:');
    console.error(err);
}

let mutedWriting = false;
let mutedWriteScheduled = false;

function saveMuted() {
    if (mutedWriting) {
        mutedWriteScheduled = true;
        return;
    }
    mutedWriting = true;
    const mutedJson = {};
    for (let key of Object.keys(muted)) {
        mutedJson[key] = {
            endsAt: muted[key].endsAt
        };
    }
    fs.writeFile('muted.json', JSON.stringify(mutedJson), () => {
        if (mutedWriteScheduled) {
            mutedWriteScheduled = false;
            saveMuted();
        } else {
            mutedWriting = false;
        }
    });
}
saveMuted();

function modifyRole(role, users, addRole) {
    let promises = [];
    for (let member of users) {
        if (!config.testing) {
            // don't mute mods or bots
            if (member.user.id === client.user.id) {
                return;
            }
            if (member.user.bot) {
                return;
            }
            if (member.roles.some(r => config.modRoles.includes(r.name))) {
                continue;
            }
        }
        let promise;
        if (addRole) {
            promise = member.addRole(role);
        } else {
            promise = member.removeRole(role);
        }
        promises.push(promise
            .then(() => [member, false])
            .catch(err => {
                console.error(err);
                return [member, true];
            }));
    }
    return Promise.all(promises).then(arr => ({
        successful: arr.filter(x => !x[1]).map(x => x[0]),
        errored: arr.filter(x => x[1]).map(x => x[0])
    }));
}

async function removeRoleSafe(member, role) {
    while (true) {
        try {
            await member.removeRole(role);
            break;
        } catch (err) {
            if (!err.code || (err.code >= 10000 && err.code <= 10000)) {
                // They're not in the server right now.
                // When they rejoin they won't have the role.
                break;
            }
            console.error(err);
            await sleep(5000);
        }
    }
}

function findFirstNum(parts) {
    for (let part of parts) {
        if (!isNaN(part)) {
            return part;
        }
    }
}

async function messageLinkBlacklisted(message) {
    const longLinkRegex = /reddit.com[\/\\]r[\/\\]cryptocurrency/i;
    if (longLinkRegex.test(message)) {
        return true;
    }
    const shortLinkRegex = /(reddit.com|redd.it)[\/\\]([a-z0-9]{6})/ig;
    while ((shortLinkInfo = shortLinkRegex.exec(message)) !== null) {
        const shortLink = 'https://www.reddit.com/' + shortLinkInfo[2];
        let res = await fetch(shortLink, {redirect: 'manual'});
        if (longLinkRegex.test(res.headers.get('location'))) {
            return true;
        }
    }
    return false;
}

client.on('message', async msg => {
    try {
        let isMod = msg.guild && msg.guild.available && msg.member &&
            msg.member.roles.some(r => config.modRoles.includes(r.name));
        if (isMod) {
            for (let user of msg.mentions.users.array()) {
                if (!user || !user.id) continue;
                await client.fetchUser(user.id);
                await msg.guild.fetchMember(user);
            }
        }
        if (msg.channel instanceof Discord.TextChannel) {
            if (await messageLinkBlacklisted(msg.content)) {
                await msg.delete();
                await msg.reply('Sorry, but links to r/cc are blacklisted' +
                    ' as per their vote manipulation policy.\nAttempts to bypass this' +
                    ' do not look good on the community and will result in a mute.');
                return;
            }
        }
        const parts = msg.content.split(' ');
        if (parts[0] === '!mute') {
            if (!isMod) {
                return;
            }
            const durationStr = findFirstNum(parts);
            let duration = parseFloat(durationStr);
            if (!duration) {
                return;
            }
            const sinbinRole = msg.guild.roles.find('name', config.sinbinRole);
            if (!sinbinRole) return;
            if (!duration || duration <= 0) return;
            duration = duration * 60 * 1000;
            if (!msg.mentions.members) return;
            const {successful, errored} = await modifyRole(sinbinRole, msg.mentions.members.array(), true);
            if (!successful.length && !errored.length) {
                return;
            }
            for (let member of successful) {
                // member.id might change if the user leaves then re-joins
                let permanentId = msg.guild.id + ' ' + member.user.id;
                if (muted[permanentId] !== undefined) {
                    clearTimeout(muted[permanentId].timeout);
                }
                const timeout = setTimeout(async () => {
                    removeRoleSafe(member, sinbinRole);
                    delete muted[permanentId];
                    saveMuted();
                }, duration);
                muted[permanentId] = {
                    timeout,
                    endsAt: Date.now() + duration,
                };
            }
            saveMuted();
            let message = '';
            if (successful.length) {
                message += 'Muted ';
                message += successful.map(x => '<@' + x.id + '>').join(', ');
                if (parseFloat(parts[1]) === 1) {
                    message += ' for 1 minute.';
                } else {
                    message += ' for ' + durationStr + ' minutes.';
                }
                message += ' Please follow the <#' + config.rulesChannelId + '>.';
            }
            if (errored.length) {
                message += 'Failed to mute ';
                message += errored.map(x => '<@' + x.id + '>').join(', ');
                message += '. <@' + config.ownerId + '> check logs and investigate.';
            }
            msg.channel.send(message);
        } else if (parts[0] === '!unmute') {
            if (!isMod) {
                return;
            }
            const sinbinRole = msg.guild.roles.find('name', config.sinbinRole);
            if (!sinbinRole) return;
            if (!msg.mentions.members) return;
            const {successful, errored} = await modifyRole(sinbinRole, msg.mentions.members.array(), false);
            if (!successful.length && !errored.length) {
                return;
            }
            for (let member of successful) {
                let permanentId = msg.guild.id + ' ' + member.user.id;
                if (muted[permanentId] !== undefined) {
                    const mutedInfo = muted[permanentId];
                    clearTimeout(mutedInfo.timeout);
                    delete muted[permanentId];
                }
            }
            saveMuted();
            let message = '';
            if (successful.length) {
                message += 'Unmuted ';
                message += successful.map(x => '<@' + x.id + '>').join(', ');
                message += '. ';
            }
            if (errored.length) {
                message += 'Failed to unmute ';
                message += errored.map(x => '<@' + x.id + '>').join(', ');
                message += '. <@' + config.ownerId + '> check logs and investigate.';
            }
            msg.channel.send(message);
        } else if (parts[0] === '!getroleid') {
            if (!isMod) {
                return;
            }
            const role = msg.guild.roles.find('name', parts.slice(1).join(' '));
            if (role) {
                msg.reply('role id: ' + role.id);
            } else {
                msg.reply('role not found');
            }
        } else if (parts[0].startsWith('!disable') || parts[0].startsWith('!enable')) {
            if (!isMod) {
                return;
            }
            let newRoleValue;
            let roleName;
            if (parts[0].startsWith('!enable')) {
                newRoleValue = true;
                roleName = parts[0].slice('!enable'.length) || parts[1];
            } else if (parts[0].startsWith('!disable')) {
                newRoleValue = false;
                roleName = parts[0].slice('!disable'.length) || parts[1];
            } else {
                throw new Error('Error parsing mod role setting command');
            }
            const modConfiguredRoles = config.modConfiguredRoles || {};
            if (!modConfiguredRoles.hasOwnProperty(roleName)) return;
            const roleConf = modConfiguredRoles[roleName];
            const role = msg.guild.roles.get(roleConf.id);
            if (!role || !msg.mentions.members) return;
            const {successful, errored} = await modifyRole(role, msg.mentions.members.array(), !!(newRoleValue ^ (!!roleConf.inverted)));
            if (!successful.length && !errored.length) {
                return;
            }
            let message = '';
            if (successful.length) {
                message += (newRoleValue ? 'Enabled ' : 'Disabled ') + (roleConf.name || roleName) + ' for ';
                message += successful.map(x => '<@' + x.id + '>').join(', ');
                message += '.';
            }
            if (errored.length) {
                message += 'Failed to ' + (newRoleValue ? 'enable ' : 'disable ') + (roleConf.name || roleName) + ' for ';
                message += errored.map(x => '<@' + x.id + '>').join(', ');
                message += '. <@' + config.ownerId + '> check logs and investigate.';
            }
            msg.channel.send(message);
        }
    } catch (err) {
        console.error(err);
    }
});

if (config.priceChannelId) {
    setInterval(async () => {
        const [cmc, ...exchanges] = await Promise.all([
            await prices.cmc(),
            ...Object.keys(prices.exchanges).map(x =>
                promiseTimeout(prices.exchanges[x](), config.exchangeApiTimeout || 2500)
                    .catch(err => console.log('Exchange API error: ' + err))
                    .then(price => [x, price])
            )
        ]);
        const embed = {};
        embed.description = `**${cmc.btc} BTC - $${cmc.usd} USD**\n` +
            `Market cap: $${cmc.market_cap} USD (#${cmc.cap_rank})\n` +
            `24h volume: $${cmc.volume} USD\n1 BTC = $${cmc.btcusd} USD`;
        if (cmc.percent_change_1h < 0) {
            embed.color = 0xed2939; // imperial red
        } else if (cmc.percent_change_1h > 0) {
            embed.color = 0x39ff14; // neon green
        }
        embed.description += '\n```\n';
        const nameFieldLength = Math.max(...exchanges.map(x => x[0].length)) + 1;
        for (let [name, price] of exchanges) {
            const nameSpacing = ' '.repeat(nameFieldLength - name.length);
            if (price) {
                embed.description += `${name}:${nameSpacing}${price} BTC\n`;
            } else {
                embed.description += `${name}:${nameSpacing}API error\n`;
            }
        }
        embed.description += '```';
        await client.channels.get(config.priceChannelId).send(new Discord.RichEmbed(embed));
    }, config.priceInterval || 60000);
}

let copycatTargets = [];
let copycatTargetDiscriminators = {};
let copycatTargetIds = new Set();
let copycatWords = [];

function preprocessCopycatName(name) {
    return name.replace(/\s/g, '');
}

function isCopycat(name, discriminator) {
    if (copycatTargets.length === 0 || !name) {
        return false;
    }
    name = preprocessCopycatName(name);
    let lengthMatches = copycatWords.slice();
    let symbolCount = 0;
    for (let char of name) {
        symbolCount++;
    }
    for (let copycatTarget of copycatTargets) {
        if (Math.abs(symbolCount - copycatTarget.length) <= 2) {
            lengthMatches.push(copycatTarget);
        }
    }
    let matchLevel = 0;
    for (let match of homoglyphSearch(name, lengthMatches)) {
        matchLevel = Math.max(matchLevel, 1);
        if (discriminator && copycatTargetDiscriminators[match.word] === discriminator) {
            matchLevel = Math.max(matchLevel, 2);
        }
    }
    return matchLevel;
}

function checkForCopycat(user, name) {
    let copycatLevel = isCopycat(name, user.discriminator);
    if (copycatLevel > 0 && !copycatTargetIds.has(user.id)) {
        let message = '^^ <@&' + config.copycatAlertRoleId + '> potential impersonator';
        if (copycatLevel > 1) {
            message += '\nsince discriminator matches, may be a ban in the future';
        }
        client.channels.get(config.nameChangeChannelId).send(message);
    }
}

client.on('userUpdate', (oldUser, newUser) => {
    let noticeablyChanged = false;
    if (oldUser.username !== newUser.username) {
        let message = '`' + oldUser.username + '` has changed their username to `' + newUser.username + '`: <@' + newUser.id + '>';
        client.channels.get(config.nameChangeChannelId).send(message);
        noticeablyChanged = true;
    }
    if (oldUser.discriminator !== newUser.discriminator) {
        let message = '`' + newUser.username + '` has changed their discriminator from #' + oldUser.discriminator + ' to #' + newUser.discriminator + ': <@' + newUser.id + '>';
        client.channels.get(config.nameChangeChannelId).send(message);
        noticeablyChanged = true;
    }
    if (noticeablyChanged) {
        checkForCopycat(newUser, newUser.username);
    }
});

client.on('guildMemberUpdate', (oldMember, newMember) => {
    let oldNick = oldMember.nickname || oldMember.user.username;
    let newNick = newMember.nickname || newMember.user.username;
    if (oldNick != newNick) {
        let message = '`' + oldNick + '` has changed their nickname to `' + newNick + '`: <@' + newMember.user.id + '>';
        client.channels.get(config.nameChangeChannelId).send(message);
        checkForCopycat(newMember.user, newNick);
    }
});

client.on('guildMemberAdd', member => {
    try {
        checkForCopycat(member.user, member.user.username);
        // Is this possible? It can't hurt.
        if (member.nickname) {
            checkForCopycat(member.user, member.nickname);
        }
    } catch (err) {
        console.error(err);
    }
    try {
        let permanentId = member.guild.id + ' ' + member.user.id;
        if (muted[permanentId] !== undefined) {
            const mutedInfo = muted[permanentId];
            clearTimeout(mutedInfo.timeout);
            const duration = mutedInfo.endsAt - Date.now();
            if (duration && duration >= 0) {
                const sinbinRole = member.guild.roles.find('name', config.sinbinRole);
                if (!sinbinRole) return;
                member.addRole(sinbinRole);
                mutedInfo.timeout = setTimeout(() => {
                    removeRoleSafe(member, sinbinRole);
                    delete muted[permanentId];
                    saveMuted();
                }, duration);
            } else {
                delete muted[permanentId];
                saveMuted();
            }
        }
    } catch (err) {
        console.error(err);
    }
});

client.on('guildMemberAdd', async member => {
    try {
        if (config.welcomeMessage && !member.user.bot) {
            let message = 'Welcome <@' + member.user.id + '> to ' + member.guild.name;
            if (config.welcomeMessage) {
                message += ':\n' + config.welcomeMessage;
            }
            await member.user.send(message);
        }
    } catch (err) {
        console.error(err);
    }
});

if (config.welcomeMessageFile) {
    config.welcomeMessage = fs.readFileSync(config.welcomeMessageFile);
}

client.login(config.token).then(() => {
    try {
        const mutedToDelete = [];
        for (const [permanentId, mutedInfo] of Object.entries(muted)) {
            const [guildId, userId] = permanentId.split(' ');
            const guild = client.guilds.get(guildId);
            if (!guild || !guild.available) continue;
            const sinbinRole = guild.roles.find('name', config.sinbinRole);
            if (!sinbinRole) continue;
            const member = guild.members.get(userId);
            if (!member) continue;
            const duration = mutedInfo.endsAt - Date.now();
            if (duration && duration >= 0) {
                mutedInfo.timeout = setTimeout(() => {
                    removeRoleSafe(member, sinbinRole);
                    delete muted[permanentId];
                    saveMuted();
                }, duration);
            } else {
                removeRoleSafe(member, sinbinRole);
                mutedToDelete.push(guildId + ' ' + userId);
            }
        }
        for (const key of mutedToDelete) {
            delete muted[key];
        }
        if (config.guildId && (config.copycatTargetRoleIds || config.copycatTargetRoleId)) {
            const guild = client.guilds.get(config.guildId);
            const roles = config.copycatTargetRoleIds || [config.copycatTargetRoleId];
            for (let roleId of roles) {
                const role = guild.roles.get(roleId);
                for (let [memberId, member] of role.members) {
                    copycatTargetIds.add(member.user.id);
                    for (let name of [member.user.username, member.nickname]) {
                        if (!name) continue;
                        name = preprocessCopycatName(name);
                        copycatTargets.push(name);
                        copycatTargetDiscriminators[name] = member.user.discriminator;
                    }
                }
            }
            if (config.copycatWords) {
                copycatWords = config.copycatWords;
            }
        }
    } catch (err) {
        console.error(err);
    }
});

process.on('unhandledRejection', err => {
    console.error('Unhandled promise rejection', err);
    process.exit(1);
});

client.on('error', console.error);
