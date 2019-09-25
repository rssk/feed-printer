'use strict';

const Mercury = require('@postlight/mercury-parser');
const Parser = require('rss-parser');
const url = require('url');
const _ = require('lodash');
const pify = require('util').promisify;
const writeFile = pify(require('fs').writeFile);
const path = require('path');
const randomUA = require('random-ua');
const config = require('./config.json');

let articlesFromDisk;
try {
  articlesFromDisk = require('./articles.json');
} catch (e) {
  articlesFromDisk = {};
}

const parser = new Parser();
const strictMatch = new RegExp(`[^?.!:; \\s]*[a-z ']*${config.matchPhrase}[^?.!;]*[?.!;]["']?`, 'ig');
const coarseMatch = new RegExp(`[^?.!:; \\s]*[a-z ']*${config.matchPhrase}[^?.!;]*`, 'ig');
const articles = Object.assign({}, articlesFromDisk);
const sessionUA = randomUA.generate();
const escpos = require('escpos');

const device = new escpos.USB();
const printer = new escpos.Printer(device);

const parsePage = (url, item) => {
  // see if we have anything from the google supplied title
  const titleMatch = item.title.replace(/<b>|<\/b>/gi, '').match(strictMatch) ||
    item.title.replace(/<b>|<\/b>/gi, '').match(coarseMatch);
  let googleTitle;

  if (titleMatch) {
    // googleTitle = _.upperFirst(titleMatch[0].trim().toLowerCase()).replace(' i ', ' I ');
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
      if (match.length < 110) {
        // match.search(/[^a-zA-Z\d\s?.!:;,'"$]/g) === -1) {
        // memo.push(_.upperFirst(match.trim().toLowerCase()).replace(' i ', ' I '));
        if (match.match(/^['"]|['"]$/ig) && match.match(/^['"]|['"]$/ig).length === 1) {
          memo.push(match.replace(/^['"]|['"]$/ig, ''));
        } else {
          if (!memo.includes(match.trim())) {
            memo.push(match.trim());
          }
        }
      }
      return memo;
    }, []);
    if (googleTitle && !matchArr.find((elem) => {
      return elem.includes(googleTitle.replace(/[?.!:;,]/, ''));
    }) &&
    googleTitle.length < 110 && googleTitle.search(/[^a-zA-Z\d\s?.!:;,'"$]/g) === -1
    ) {
      matchArr.push(googleTitle);
    }
    articles[item.id] = { article: item, matches: matchArr };
    return { url: item.link, id: item.id, matches: matchArr };
  })
    .catch((err) => {
      articles[item.id] = { article: item, error: err.message };
      if (googleTitle &&
        googleTitle.length < 110 && googleTitle.search(/[^a-zA-Z\d\s?.!:;,'"$]/g) === -1
      ) {
        // our crawler cant access, but we have something from goog
        return { url: item.link, id: item.id, matches: [googleTitle] };
      }
      throw Object.assign({}, err, { id: item.id, url: item.link });
    });
};
const checkFeed = () => {
  return parser.parseURL(config.feedURL)
    .then((feed) => {
      const promArr = [];
      feed.items.forEach((item) => {
        if (!articles[item.id]) {
          promArr.push(parsePage(url.parse(item.link, true).query.url, item));
        }
      });
      return Promise.all(promArr.map(p => p.catch(e => e)));
    }).then((articleResults) => {
      if (articleResults) {
        return new Promise(function (resolve, reject) {
          device.open(() => {
            resolve(printer);
          });
        })
          .then((printer) => {
            console.log(`Printing ${articleResults.length} articles....`);
            articleResults.forEach((article) => {
              if (article.matches && article.matches.length !== 0) {
                article.matches.forEach(match => {
                  printer.font('a').text(match);
                });
              }
            });
            return new Promise(function (resolve, reject) {
              printer.close(() => resolve());
            });
          }).then(() => {
            console.log('Done printing, writing to DB');
            return writeFile(path.join('.', 'articles.json'), JSON.stringify(articles));
          });
        // const htmlBody = articleResults.reduce((memo, result) => {
        //   if (result.matches && result.matches.length !== 0) {
        // return memo.concat(`<h2>Article:</h2> ${result.url}<h3>ID: ${result.id}</h3>\r\n<h3>Matches:</h3><b>${result.matches.join('<br>')}</b><br><br>`);
        // }
        // console.log('failed /*******************/');
        // console.log(result.id || '');
        // console.log(result.url || '');
        // console.log(result.matches || '');
        // console.log(result.name || '');
        //   return memo;
        // }, '');
        // if (htmlBody) {
        //   console.log('sending mail');
        //   return transporter.sendMail(mailOptions)
        //     .then(() => writeFile(path.join('.', 'articles.json'), JSON.stringify(articles)));
        // }
        // console.log('no valid matches, writing db');
        // console.log(articles);
      }
    });
};

if (process.argv[2]) {
  console.log('replaying result...');
  const article = articlesFromDisk[process.argv[2]].article;
  parsePage(url.parse(article.link, true).query.url, article)
    .then((res) => {
      console.log(res);
    }).catch(e => {
      console.log(e);
    });
} else {
  // check the rss feed erry minute
  checkFeed().then(() => setInterval(checkFeed, 60000));
}
