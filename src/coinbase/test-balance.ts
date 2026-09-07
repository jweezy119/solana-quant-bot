import 'dotenv/config';
import { generateToken } from './auth';

const COINBASE_API_NAME = process.env.COINBASE_API_NAME || '';
const COINBASE_API_PRIVATE_KEY = (process.env.COINBASE_API_PRIVATE_KEY || '').replace(/\\n/g, '\n');

async function testConnection() {
  if (!COINBASE_API_NAME || !COINBASE_API_PRIVATE_KEY) {
    console.error('❌ Missing Coinbase API credentials in .env');
    console.error('Please add COINBASE_API_NAME and COINBASE_API_PRIVATE_KEY to your .env file.');
    return;
  }

  const requestMethod = 'GET';
  const requestPath = '/api/v3/brokerage/accounts';
  
  try {
    const token = await generateToken(COINBASE_API_NAME, COINBASE_API_PRIVATE_KEY, requestMethod, requestPath);
    
    console.log('📡 Fetching Coinbase accounts...');
    const response = await fetch(`https://api.coinbase.com${requestPath}`, {
      method: requestMethod,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API Error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as any;
    console.log('✅ Successfully connected to Coinbase Advanced Trade API!');
    console.log(`Found ${data.accounts?.length || 0} accounts.`);
    
    // Print first few accounts with balances
    if (data.accounts) {
        data.accounts
            .filter((acc: any) => parseFloat(acc.available_balance.value) > 0)
            .slice(0, 5)
            .forEach((acc: any) => {
                console.log(`  - ${acc.currency}: ${acc.available_balance.value}`);
            });
    }

  } catch (error: any) {
    console.error('❌ Connection Failed:', error.message);
  }
}

if (require.main === module) {
  testConnection();
}
