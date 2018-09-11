const fs = require('fs');
const config = require('./config.js');
const { GraphQLClient } = require('graphql-request');

const query = fs.readFileSync('./query.graphql', 'utf8');

const elasticsearch = require('elasticsearch');
const moment = require('moment');

const client = new elasticsearch.Client(config.elasticsearch);

const graphqlClient = new GraphQLClient('https://api.github.com/graphql', {
  headers: {
    'Authorization': `bearer ${config.githubToken}`
  }
});

/**
 * Enhace a passed in date, into an object that contains further useful
 * information about that date (e.g. day of the week or hour of day).
 */
function enhanceDate(date) {
  if (!date) return null;

  const m = moment(date);
  return {
    time: m.format(),
    weekday: m.format('ddd'),
    weekday_number: parseInt(m.format('d')),
    hour_of_day: parseInt(m.format('H'))
  };
}

function buildPrInfo(issue) {
  const reviewers = issue.reviews.edges.map(({ review }) => review.author.login);
  const uniqueReviewers = [...new Set(reviewers)];
  return {
    additions: issue.additions,
    deletions: issue.deletions,
    changed_files: issue.changedFiles,
    commits: issue.commits.totalCount,
    merged: issue.merged,
    merged_by: issue.mergedBy,
    reviewers: uniqueReviewers,
  };
}

function buildReactions(reactions) {
  return {
    upVote: reactions.find(r => r.content === 'THUMBS_UP').users.totalCount,
    downVote: reactions.find(r => r.content === 'THUMBS_DOWN').users.totalCount,
    laugh: reactions.find(r => r.content === 'LAUGH').users.totalCount,
    hooray: reactions.find(r => r.content === 'HOORAY').users.totalCount,
    confused: reactions.find(r => r.content === 'CONFUSED').users.totalCount,
    heart: reactions.find(r => r.content === 'HEART').users.totalCount,
  };
}

/**
 * Takes in the raw issue from the GitHub API response and must return the
 * object that should be stored inside Elasticsearch.
 */
function convertIssue(owner, repo, raw) {
  const isPr = Boolean(raw.pr);
  const time_to_fix = (raw.createdAt && raw.closedAt) ?
      moment(raw.closedAt).diff(moment(raw.createdAt)) :
      null;
  return {
    id: raw.id,
    owner: owner,
    repo: repo,
    state: isPr ? raw.prState : raw.state,
    title: raw.title,
    number: raw.number,
    url: raw.url,
    locked: raw.locked,
    comments: raw.comments.totalCount,
    created_at: enhanceDate(raw.createdAt),
    updated_at: enhanceDate(raw.updatedAt),
    closed_at: enhanceDate(raw.closedAt),
    author_association: raw.authorAssociation,
    user: raw.author.login,
    body: raw.body,
    labels: raw.labels.edges.map(({ label }) => label.name),
    is_pullrequest: isPr,
    assignees: raw.assignees.edges.length === 0 ? 
        null : raw.assignees.edges.map(({ assignee }) => assignee.login),
    reactions: {
      total: raw.reactionCount.totalCount,
      ...buildReactions(raw.reactions),
    },
    time_to_fix: time_to_fix,
    pr: isPr ? buildPrInfo(raw) : null,
  };
}

/**
 * Create a bulk request body for all issues. You need to specify the index in
 * which these issues should be stored.
 */
function getIssueBulkUpdates(index, issues) {
  return [].concat(...issues.map(issue => [
    { index: { _index: index, _type: 'doc', _id: issue.id }},
    issue
  ]));
}

/**
 * Processes a GitHub response for the specified page of issues.
 * This will convert all issues to the desired format, store them into
 * Elasticsearch and update the cache key, we got from GitHub.
 */
async function processGitHubIssues(owner, repo, response) {
  const issues = response.issues.edges.map(({ issue }) => convertIssue(owner, repo, issue));
  const bulkIssues = getIssueBulkUpdates(`issues-${owner}-${repo}`, issues);
  console.log('Writing issues to Elasticsearch');
  await client.bulk({ body: bulkIssues });
  console.log('Finished writing issues to Elasticsearch');
}

async function processRepos() {
  for (const repository of config.repos) {
    console.log(`Processing repository ${repository}`);
  	const [ owner, repo ] = repository.split('/');
    let cursor = null;
    let hasNextPage = true;
    while (hasNextPage) {
      console.log(`Process page for cursor: ${cursor}`);

      const { data, headers } = await graphqlClient.rawRequest(query, {
        query: `repo:"${repository}"`,
        cursor: cursor,
      });

      console.log(`X-GitHub-Request-Id: ${headers.get('x-github-request-id')}`);

      const { cost, remaining, limit } = data.rateLimit;
      console.log(`Rate limit: ${remaining}/${limit} (Cost: ${cost})`);
      await processGitHubIssues(owner, repo, data);
      cursor = data.issues.pageInfo.endCursor;
      hasNextPage = data.issues.pageInfo.hasNextPage;
    }
    console.log(`Finished processing ${repository}`);
  }
}

processRepos();
