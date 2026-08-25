const fs = require('fs');
const p = 'test/access-control/access-control.e2e-spec.ts';
const lines = fs.readFileSync(p, 'utf8').split('\n');
console.log(669, JSON.stringify(lines[668]));
console.log(730, JSON.stringify(lines[729]));
