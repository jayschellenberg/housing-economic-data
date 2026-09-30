import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countDataRows, tokenizeRows } from '../src/lib/delimitedRows.js';

test('tokenizeRows handles quoted commas, doubled quotes and CRLF', () => {
  const text = 'a,b,c\r\n1,"x, y","say ""hi"""\r\n2,,\n';
  assert.deepEqual(tokenizeRows(text), [
    ['a', 'b', 'c'],
    ['1', 'x, y', 'say "hi"'],
    ['2', '', ''],
  ]);
});

test('tokenizeRows keeps a quoted newline inside a cell', () => {
  const text = 'id,title\n1,"two\nlines"\n2,one';
  assert.deepEqual(tokenizeRows(text), [['id', 'title'], ['1', 'two\nlines'], ['2', 'one']]);
});

test('tokenizeRows drops blank lines', () => {
  assert.deepEqual(tokenizeRows('a,b\n\n1,2\n\n'), [['a', 'b'], ['1', '2']]);
});

test('countDataRows excludes the header and is quote-aware', () => {
  assert.equal(countDataRows('a,b\n1,2\n3,4\n'), 2);
  assert.equal(countDataRows('a,b\n1,"x\ny"\n'), 1);
  assert.equal(countDataRows('a,b\n'), 0);
  assert.equal(countDataRows(''), 0);
});
