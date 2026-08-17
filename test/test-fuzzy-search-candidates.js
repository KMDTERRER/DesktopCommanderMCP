#!/usr/bin/env node
import assert from 'node:assert';
import { recursiveFuzzyIndexOf, getSimilarityRatio } from '../dist/tools/fuzzySearchCore.js';

function main() {
  const target = 'unique_report_anchor_python_fuzzy_25 = "original: Desktop Commander MCP handles files, commands, and edit blocks"';
  const query = target.replace('Commander', 'Comander');
  const filler = Array.from({ length: 700 }, (_, index) =>
    `README note ${index}: Desktop tools can inspect code, terminal state, configuration, and ordinary documentation.`);
  const text = ['# header', target, '', ...filler].join('\n');
  const result = recursiveFuzzyIndexOf(text, query);
  assert.equal(result.value, target, `large-file fuzzy search selected the wrong line: ${result.value}`);
  assert.equal(result.distance, 1);
  assert(getSimilarityRatio(query, result.value) > 0.98);

  const multiTarget = 'const alpha = 1;\nconst service = "Desktop Commander";\nreturn service;';
  const multiQuery = multiTarget.replace('Commander', 'Comander');
  const multiText = `prefix noise\n${multiTarget}\nsuffix noise`;
  const multi = recursiveFuzzyIndexOf(multiText, multiQuery);
  assert(getSimilarityRatio(multiQuery, multi.value) > 0.95,
    `q-gram candidate search missed a near-exact multiline target: ${multi.value}`);

  console.log('fuzzy search candidates: PASS');
}

main();
