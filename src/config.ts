import { existsSync } from 'node:fs';
import {transportConfig} from './transport.js';
if(existsSync('.env'))process.loadEnvFile('.env');
export const production=process.env.NODE_ENV==='production';
if(production&&!process.env.DATABASE_URL)throw new Error('Production requires DATABASE_URL');
if(production&&(!process.env.PUBLIC_ORIGIN?.startsWith('https://')))throw new Error('Production requires an HTTPS PUBLIC_ORIGIN');
export const config={databaseUrl:process.env.DATABASE_URL,dataDir:process.env.DATA_DIR??'./data/postgres',port:Number(process.env.PORT??4180),...transportConfig(process.env)};
