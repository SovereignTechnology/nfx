/** Unit checks for the player's pure helpers (`npm run unit`). */
import { originBase } from './src/resolve';

const cases: [string, string | null][] = [
  ['https://seed.example/nfx', 'https://seed.example/nfx'],
  ['https://seed.example/nfx/', 'https://seed.example/nfx'],
  ['https://127.0.0.1:38477', 'https://127.0.0.1:38477'],
  ['http://seed.example', null], // beacons name https origins only
  ['https://router.local/admin?x=', null], // a query would steer /<root>/… requests
  ['https://seed.example/#frag', null],
  ['https://user:pw@seed.example', null],
  ['not a url', null],
];
let bad = 0;
for (const [input, want] of cases) {
  const got = originBase(input);
  if (got !== want) {
    bad++;
    console.error(`originBase(${JSON.stringify(input)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}
console.log(`originBase: ${cases.length - bad}/${cases.length} ok`);
process.exit(bad === 0 ? 0 : 1);
