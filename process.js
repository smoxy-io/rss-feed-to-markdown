const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { parseStringPromise } = require('xml2js');
const sanitize = require('sanitize-filename');
const TurndownService = require('turndown');
const {format} = require('date-fns');


const imageTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif'];

function parseFeedUrls(feedUrl, feedUrlsFile) {
  let feedUrls = [];
  if (feedUrl) {
    try {
      const parsedFeedUrl = JSON.parse(feedUrl);
      if (Array.isArray(parsedFeedUrl)) {
        feedUrls = parsedFeedUrl;
      } else {
        feedUrls.push(feedUrl);
      }
    } catch (error) {
      feedUrls.push(feedUrl);
    }
  } else if (feedUrlsFile) {
    if (!fs.existsSync(feedUrlsFile)) {
      throw new Error(`Feed URLs file '${feedUrlsFile}' does not exist.`);
    }
    const feedUrlsContent = fs.readFileSync(feedUrlsFile, 'utf8');
    try {
      feedUrls = JSON.parse(feedUrlsContent);
    } catch (error) {
      // If JSON parsing fails, treat it as a plain text file
      feedUrls = feedUrlsContent
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));
    }
  } else {
    throw new Error('Either feed_url or feed_urls_file must be provided.');
  }
  return feedUrls;
}

async function processFeeds(feedUrls, template, outputDir, dateFormat) {
  for (const url of feedUrls) {
    try {
      // Fetch and parse the RSS feed
      const feedData = await fetchAndParseFeed(url);
      const feedType = detectFeedType(feedData);

      let entries;

      if (feedType === 'atom') {
        // Atom Feed
        entries = feedData.feed.entry;
      } else if (feedType === 'rss') {
        // RSS Feed
        entries = feedData?.rss?.channel?.[0]?.item || [];
      } else {
        throw new Error('Unknown feed type.');
      }

      // Process the feed entries and generate Markdown files
      entries.forEach((entry) => {
        try {
          const { output, date, title } = generateFeedMarkdown(template, entry, dateFormat);
          const filePath = saveMarkdown(outputDir, date, title, output);

          console.log(`Markdown file '${filePath}' created.`);
        } catch (error) {
          console.error(`Error processing feed entry for ${url}`);
          console.error(error.message);
        }
      });
    } catch (error) {
      console.error(`Error processing feed at ${url}`);
      console.error(error.message);
    }
  }
}

// Fetch the RSS feed
async function fetchAndParseFeed(feedUrl) {
  const response = await axios.get(feedUrl);
  const feedData = response.data;

  if (typeof feedData === 'object') {
    // Assume it's a JSON feed
    return feedData;
  } else {
    // Assume it's an XML feed (RSS or Atom)
    return parseStringPromise(feedData);
  }
}

// Helper function to detect feed type based on entry fields
function detectFeedType(feedData) {
  if (feedData?.feed?.entry) {
    return 'atom';
  } else if (feedData?.rss?.channel) {
    return 'rss';
  } else {
    return 'unknown';
  }
}

// Main function for generating Markdown 
const generateFeedMarkdown = (template, entry, dateFormat) => {
  
  const id =
    entry['yt:videoId']?.[0] ||
    entry.id?.[0] ||
    entry.guid?.[0]?.['_'] ||
    entry.guid?.[0] ||
    '';
  let date = entry.published?.[0] || entry.pubDate?.[0] || entry.updated?.[0] || '';
  const link = entry.link?.[0]?.$?.href || entry.link?.[0] || '';
  const titleRaw = typeof entry.title?.[0] === 'string' ? entry.title[0] : entry.title?.[0]?._ || '';
  const title = titleRaw.replace(/[^\w\s-]/g, '') || '';

  if (dateFormat) {
    date = format(new Date(date), dateFormat);
  }

  // Extract and clean up content for Markdown conversion and description
  const content =
    entry.description?.[0] ||
    entry['media:group']?.[0]?.['media:description']?.[0] ||
    entry.content?.[0]?._ || '';
  const markdown = new TurndownService({
    codeBlockStyle: 'fenced',
    fenced: '```',
    bulletListMarker: '-',
  }).turndown(content);
  const description =
    entry.summary?.[0]?._ ||
    entry.summary?.[0] ||
    (content
      ? content.replace(/(<([^>]+)>)/gi, '').split(' ').splice(0, 50).join(' ')
      : '');

  // Extract author, handling possible formats across feed types
  const author =
    entry.author?.[0]?.name?.[0] ||
    entry['dc:creator']?.[0] ||
    entry.author?.[0] ||
    entry.author ||
    'Unknown Author';

  // Extract media information (video, images, etc.) with checks for feed type specifics
  const video = entry['media:group']?.[0]?.['media:content']?.[0]?.$?.url || '';
  const image =
    entry['media:group']?.[0]?.['media:thumbnail']?.[0]?.$.url ||
    entry['media:thumbnail']?.[0]?.$.url ||
    entry['media:content']?.[0]?.$.url ||
    '';
  const images =
    (entry['enclosure'] || entry['media:content'])
      ?.filter((e) => imageTypes.includes(e.$['type']))
      ?.map((e) => e.$.url) || [];

  // Handle categories with flexibility for both RSS and Atom structures
  const categories = (entry.category || []).map((cat) =>
    typeof cat === 'string' ? cat : cat?.$?.term || cat
  );

  // Specific to YouTube (if present)
  const views =
    entry['media:group']?.[0]?.['media:community']?.[0]?.['media:statistics']?.[0]?.$.views || '';
  const rating =
    entry['media:group']?.[0]?.['media:community']?.[0]?.['media:starRating']?.[0]?.$.average || '';

  // Final output preparation
  return generateOutput(template, {
    id,
    date,
    link: link.trim(),
    title,
    content,
    markdown,
    description,
    author,
    video,
    image,
    images,
    categories,
    views,
    rating,
  });
};


// Helper function to generate the output
const generateOutput = (template, data) => {
  const output = template
    .replaceAll('[ID]', data.id || '')
    .replaceAll('[DATE]', data.date || '')
    .replaceAll('[LINK]', data.link || '')
    .replaceAll(
      '[TITLE]',
      (data.title.trim() || '').replace(/\s+/g, ' '),
    )
    .replaceAll(
      '[DESCRIPTION]',
      typeof data.description === 'string'
        ? data.description.replace(/\s+/g, ' ')
        : '',
    )
    .replaceAll('[CONTENT]', data.content|| '')
    .replaceAll('[MARKDOWN]', data.markdown || '')
    .replaceAll('[AUTHOR]', data.author || '')
    .replaceAll('[VIDEO]', data.video || '')
    .replaceAll('[IMAGE]', data.image || '')
    .replaceAll('[IMAGES]', (data.images || []).join(','))
    .replaceAll('[CATEGORIES]', (data.categories || []).join(','))
    .replaceAll('[VIEWS]', data.views || '')
    .replaceAll('[RATING]', data.rating || '');

  return { output, date: data.date || '', title: data.title || '' };
};

function saveMarkdown(outputDir, date, title, markdown) {
  const formattedDate = date ? new Date(date).toISOString().split('T')[0] : '';
  const slug = sanitize(
    `${formattedDate}-${title.toLowerCase().replace(/\s+/g, '-')}`,
  ).substring(0, 50);
  const fileName = `${slug}.md`;
  const filePath = path.join(outputDir, fileName);

  fs.writeFileSync(filePath, markdown);

  return filePath;
}

module.exports = {
  parseFeedUrls,
  processFeeds,
  fetchAndParseFeed,
  generateFeedMarkdown,
  saveMarkdown,
};
