const web3 = require('@solana/web3.js');
const bs58 = require('bs58');
require('dotenv').config();

async function checkBalance() {
  try {
    const secretKeyString = process.env.PRIVATE_KEY;
    if (!secretKeyString) {
      console.log('No PRIVATE_KEY found in .env');
      return;
    }
    const secretKey = bs58.decode(secretKeyString.replace(/\s+/g, ''));
    const keypair = web3.Keypair.fromSecretKey(secretKey);
    console.log('Wallet Address:', keypair.publicKey.toBase58());

    const rpc = process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 'https://api.mainnet-beta.solana.com';
    const connection = new web3.Connection(rpc, 'confirmed');
    
    const balance = await connection.getBalance(keypair.publicKey);
    console.log('Balance:', balance / web3.LAMPORTS_PER_SOL, 'SOL');
  } catch (e) {
    console.error('Error:', e);
  }
}

checkBalance();
