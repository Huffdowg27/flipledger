import { NextResponse } from 'next/server';
import { startAutoSync } from '@/lib/sp-api/auto-sync';

let initialized = false;

export async function GET() {
  if (!initialized) {
    startAutoSync();
    initialized = true;
    return NextResponse.json({ status: 'started' });
  }
  return NextResponse.json({ status: 'already running' });
}
