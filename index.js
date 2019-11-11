'use strict';

const Mercury = require('@postlight/mercury-parser');
const Parser = require('rss-parser');
const url = require('url');
const _ = require('lodash');
const pify = require('util').promisify;
const writeFile = pify(require('fs').writeFile);
const readFile = pify(require('fs').readFile);
const randomUA = require('random-ua');
const defaultConf = require('./config.json');
const escpos = require('escpos');
const moment = require('moment');
const EventEmitter = require('events');
var stringSim = require('string-similarity');

const saveEmitter = new EventEmitter();

const parsePage = (url, item, articles, config) => {
  const strictMatch = new RegExp(`[^?.!:; \\s]*[a-z ']*${config.matchPhrase} [^?.!;]*[?.!;]["']?`, 'ig');
  const coarseMatch = new RegExp(`[^?.!:; \\s]*[a-z ']*${config.matchPhrase} [^?.!;]*`, 'ig');
  const sessionUA = randomUA.generate();
  // see if we have anything from the google supplied title
  const titleMatch = item.title.replace(/<b>|<\/b>/gi, '').match(strictMatch) ||
    item.title.replace(/<b>|<\/b>/gi, '').match(coarseMatch);
  let googleTitle;

  if (titleMatch) {
    googleTitle = titleMatch[0].trim();
  }

  return Mercury.parse(url, {
    headers: {
      'User-Agent': sessionUA
    },
    contentType: 'text'
  }
  ).then((article) => {
    const title = article.title.match(strictMatch) || article.title.match(coarseMatch);
    const content = article.content.match(strictMatch);

    const matchArr = _.union(
      title || [],
      content || []
    ).reduce((memo, match) => {
      if (match.length < 104) {
        if (match.match(/^['"“”‘’]|['"“”‘’]$/ig) && match.match(/^['"“”‘’]|['"“”‘’]$/ig).length === 1) {
          match = match.replace(/^['"“”‘’]|['"“”‘’]$/ig, '').trim();
          if (memo.every((elem) => { return stringSim.compareTwoStrings(elem, match) < 0.9; })) memo.push(match);
        } else {
          match = match.trim();
          if (memo.every((elem) => { return stringSim.compareTwoStrings(elem, match) < 0.9; })) memo.push(match);
        }
      }
      return memo;
    }, []);
    // articles[item.id] = { article: item, matches: matchArr };
    return { url: item.link, id: item.id, matches: matchArr, date: item.isoDate };
  })
    .catch((err) => {
      // console.error(JSON.stringify({ article: item, error: err.message }));
      if (googleTitle &&
        googleTitle.length < 110 && googleTitle.search(/[^a-zA-Z\d\s?.!:;,'"“”‘’$]/g) === -1
      ) {
        // our crawler cant access, but we have something from goog
        return { url: item.link, id: item.id, matches: [googleTitle], date: item.isoDate, error: err.message };
      }
      throw Object.assign({}, err, { id: item.id, url: item.link });
    });
};
const checkFeed = (articles, dbPath, config) => {
  const parser = new Parser();
  return parser.parseURL(config.feedURL)
    .then((feed) => {
      const promArr = [];
      feed.items.forEach((item) => {
        if (!articles[item.id]) {
          promArr.push(parsePage(url.parse(item.link, true).query.url, item, articles, config));
        }
      });
      return Promise.all(promArr.map(p => p.catch(e => e)));
    }).then((articleResults) => {
      // do pruning
      articles = Object.assign(articles, articleResults.reduce((memo, article) => {
        memo[article.id] = article; return memo;
      }, {}));
      console.log('Saving articles');
      saveEmitter.emit('saving');
      return new Promise(resolve => setTimeout(resolve, 5000))
        .then(() => {
          return writeFile(dbPath, JSON.stringify(articles, null, 2))
            .then(() => saveEmitter.emit('saved'));
        });
    });
};

module.exports = {
  start (dbPath, inputConfig) {
    const config = Object.assign({}, defaultConf, inputConfig);
    return readFile(dbPath, { flag: 'a+' })
      .then((articleDB) => {
        let articles = {};
        if (articleDB) {
          try {
            articles = JSON.parse(articleDB);
          } catch (e) {}
        }
        if (process.argv[2]) {
          console.log('replaying result...');
          const article = articles[process.argv[2]];
          if (article) {
            return parsePage(url.parse(article.url, true).query.url, {
              title: '',
              link: article.url,
              id: article.id,
              isoDate: article.date
            }, article, config)
              .then((res) => {
                console.log(res);
              });
          }
          console.error('No such article stored');
        } else {
          const printEmitter = new EventEmitter();
          if (!config.dryRun) {
            const device = new escpos.USB();
            const printer = new escpos.Printer(device);
            let printed = [];
            const print = () => {
              const randPrintTime = config.printInterval * 60 +
              Math.floor(config.printInterval * 60 * (Math.random() * 2 - 1) / 10);

              setTimeout(() => {
                new Promise(function (resolve, reject) {
                  device.open(() => {
                    resolve(printer);
                  });
                })
                  .then((printer) => {
                    const timeConf = config.fromTimeAgo.split(' ');
                    const diffTime = moment().subtract(timeConf[0], timeConf[1]);
                    const articleIds = Object.keys(articles);
                    console.log(articleIds.length);
                    let i = 0;
                    let article;
                    if (articleIds.every(elem => printed.includes(elem))) printed = [];
                    while (i < articleIds.length) {
                      if (!printed.includes(articleIds[i]) &&
                        articles[articleIds[i]].matches &&
                        articles[articleIds[i]].matches.length !== 0 &&
                        moment(articles[articleIds[i]].date).isAfter(diffTime)
                      ) {
                        article = articles[articleIds[i]];
                        printed.push(articleIds[i]);
                        break;
                      } else {
                        printed.push(articleIds[i]);
                      }
                      i += 1;
                    }
                    if (article) {
                      console.log(`Printing article....`);
                      article.matches.forEach(match => {
                        printer.font('a').text(match);
                        console.log(match);
                      });
                      printer.control('FF');
                      printer.close(() => printEmitter.emit('print'));
                    } else {
                      printEmitter.emit('print');
                    }
                  });
              }, randPrintTime * 1000);
            };
            printEmitter.on('print', () => {
              // stack safety
              process.nextTick(print);
            });
            print();
          }
          // check the rss feed erry minute
          return checkFeed(articles, dbPath, config).then(() => {
            return new Promise((resolve, reject) => {
              const interval = setInterval(() => {
                checkFeed(articles, dbPath, config)
                  .catch((e) => {
                    clearInterval(interval);
                    reject(e);
                  });
              }, 60000);
            });
          });
        }
      });
  },
  saveEmitter
};
