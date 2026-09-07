import { getAccountBalance } from './src/coinbase/client';
async function main() {
  const bal = await getAccountBalance('USELESS');
  console.log("USELESS Balance:", bal);
}
main();
