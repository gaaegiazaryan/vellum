import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

export const PLAID_CLIENT_TOKEN = Symbol('PLAID_CLIENT_TOKEN');

export interface PlaidClientEnv {
  PLAID_CLIENT_ID: string;
  PLAID_SECRET: string;
  PLAID_ENV: 'sandbox' | 'development' | 'production';
}

export function createPlaidClient(env: PlaidClientEnv): PlaidApi {
  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[env.PLAID_ENV],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': env.PLAID_CLIENT_ID,
          'PLAID-SECRET': env.PLAID_SECRET,
        },
      },
    }),
  );
}
