import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const queries = [
  'magpie-doubao-work','Magpie','豆包','豆包工作','豆包插件','豆包工作插件',
  'Doubao','Doubao Work','Doubao Work Plugin','doubao-work','doubaowork',
  'Magpie 豆包工作','Magpie provider plugin','provider plugin','供应商插件',
  'browser login','浏览器登录','JSON','导入','OpenAI','text chat','SSE','streaming',
  '流式','quotas','额度','daily check-in','自动签到','Windows','Linux','macOS',
];

test('独立插件的名称、入口与中英文元数据满足 Magpie 字段约束',async () => {
  assert.equal(pkg.name,'magpie-doubao-work');
  assert.equal(pkg.main,'./magpie/index.mjs');
  assert.equal(pkg.repository.url,'https://github.com/3294798852/magpie-doubao-work.git');
  assert(Buffer.byteLength(pkg.magpie.name) <= 80);
  for (const language of ['zh','en']) {
    assert(Buffer.byteLength(pkg.magpie.summary[language]) <= 300,language+' summary exceeds 300 bytes');
    assert(!pkg.magpie.summary[language].includes('\n'));
  }
  assert(pkg.keywords.includes('magpie-plugin'));
  assert(pkg.keywords.includes('豆包工作'));
  const module = await import('../magpie/index.mjs');
  assert.equal(typeof module.default,'function');
  const plugin = await module.default({client:{}}), config = {};
  plugin.config(config);
  assert(config.provider.doubaowork.name.includes('豆包工作'));
  assert(config.provider.doubaowork.name.includes('Doubao Work'));
});

// Matches the fields and substring comparison in Magpie's plugins.js.
for (const language of ['zh','en']) {
  test(language+' 界面的中英文名称、别名与常用词组可检索',() => {
    const listing = {name:pkg.magpie.name,package:'github:3294798852/magpie-doubao-work',
      summary:pkg.magpie.summary,github:{owner:'3294798852'}};
    const summary = listing.summary[language] || listing.summary.en || '';
    const haystack = [listing.name,listing.package,summary,'','',listing.github.owner].join(' ').toLowerCase();
    for (const query of queries) assert(haystack.includes(query.trim().toLowerCase()),language+': '+query);
  });
}
