#!/usr/bin/env -S npx tsx

const lines = [
  'compass — keep an architectural map of your codebase next to the code itself.',
  '',
  'Commands:',
  '  /compass-scan [--depth N]   Full analysis from scratch.',
  '  /compass-refresh            Incremental update via git diff.',
  '  /compass-expand <id>        Drill one component deeper (sub-diagram).',
  '  /compass-status             Manifest vs. working-tree drift report.',
  '  /compass-recover            Resume an interrupted run.',
  '  /compass-help               Print this message.',
  '',
  'See the README at https://github.com/AshokNaik009/compass for the full guide.',
];
console.log(lines.join('\n'));
