const fetch = require('node-fetch');

module.exports.cmc = async function() {
    const res = await fetch('https://api.coinmarketcap.com/v2/ticker/1567/?convert=BTC');
    if (res.status !== 200) {
        throw new Error('Coin market cap returned non-ok status code ' + res.status);
    }
    const json = await res.json();
    return {
        btc: (+json.data.quotes.BTC.price).toFixed(8),
        usd: (+json.data.quotes.USD.price).toFixed(2),
        btcusd: Math.round(json.data.quotes.USD.price / json.data.quotes.BTC.price).toLocaleString(), // it works :P
        volume: Math.round(json.data.quotes.USD.volume_24h).toLocaleString(),
        market_cap: Math.round(json.data.quotes.USD.market_cap).toLocaleString(),
        cap_rank: Math.round(json.data.rank).toLocaleString(),
        percent_change_1h: json.data.quotes.USD.percent_change_1h
    };
};

module.exports.exchanges = {};

module.exports.exchanges.Binance = async function() {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=NANOBTC');
    if (res.status !== 200) {
        throw new Error('Binance returned status code ' + res.status + '\n' + await res.text());
    }
    const json = await res.json();
    return (+json.price).toFixed(8);
};

module.exports.exchanges.KuCoin = async function() {
    const res = await fetch('https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=NANO-BTC');
    if (res.status !== 200) {
        throw new Error('Kucoin returned status code ' + res.status + '\n' + await res.text());
    }
    const json = await res.json();
    if (json.code != 200000) { // Should be non-strict comparison (currently a string)
        throw new Error('Kucoin returned non-successful body: ' + JSON.stringify(json));
    }
    return (+json.data.price).toFixed(8);
};
