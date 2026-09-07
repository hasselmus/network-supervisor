import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOpenAIText } from '../src/ai.mjs';

test('extracts text from Responses API output items', () => {
  const text = extractOpenAIText({
    output: [
      { type:'reasoning', summary:[] },
      { type:'message', content:[{ type:'output_text', text:'Probable bedroom AP fault.' }] }
    ]
  });
  assert.equal(text, 'Probable bedroom AP fault.');
});

test('accepts SDK-style output_text when present', () => {
  assert.equal(extractOpenAIText({ output_text:'Network healthy.' }), 'Network healthy.');
});
