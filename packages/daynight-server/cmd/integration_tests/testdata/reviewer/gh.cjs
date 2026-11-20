#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.REVIEW_FIXTURE_STATE, 'utf8'));
if (args[0] !== 'api' || !args.includes('--include')) throw Error('unexpected gh operation');
const endpoint = args[args.length - 1];
const query = args.find(arg => arg.startsWith('query=')) || '';
if (endpoint === 'graphql' && !args.includes('number=1')) throw Error('unexpected GraphQL pull request');
const info = {hasNextPage: false, endCursor: null};
const connection = nodes => ({totalCount: nodes.length, nodes, pageInfo: info});
const target = {number: 1, state: 'OPEN', isDraft: false, headRefOid: state.head, baseRefName: 'trunk'};
let data;
if (endpoint === 'repos/example/integration') data = {id: 42};
else if (endpoint === 'repos/example/integration/pulls/1') data = {number: 1, state: 'open', draft: false, merged_at: null, head: {sha: state.head}, base: {ref: 'trunk', sha: state.base, repo: {id: 42}}};
else if (endpoint === 'graphql' && query.includes('PullRequestChecks')) {
  const commit = {oid: state.head, statusCheckRollup: {state: 'SUCCESS'}, checkSuites: connection([])};
  data = {data: {repository: {pullRequest: {...target, commits: {nodes: [{commit}]}, potentialMergeCommit: null}}}};
} else if (endpoint === 'graphql' && query.includes('PullRequestReviewSnapshot')) {
  let reviews = [];
  try { reviews = [JSON.parse(fs.readFileSync(process.env.REVIEW_FIXTURE_PUBLICATION, 'utf8'))]; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  data = {data: {viewer: {id: 'fixture-viewer'}, repository: {fullDatabaseId: '42', pullRequest: {...target, reviews: connection(reviews), reviewThreads: connection([])}}}};
} else throw Error('unexpected gh request: ' + endpoint);
fs.appendFileSync(process.env.REVIEW_FIXTURE_REQUESTS, JSON.stringify({endpoint, type: query.includes('PullRequestChecks') ? 'checks' : query.includes('PullRequestReviewSnapshot') ? 'reviews' : 'rest'}) + '\n');
process.stdout.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify(data));
