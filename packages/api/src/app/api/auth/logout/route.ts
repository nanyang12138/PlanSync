import { NextResponse } from 'next/server';

export async function POST() {
  const response = NextResponse.json({ success: true });
  response.cookies.set('plansync-apikey', '', { path: '/', maxAge: 0 });
  response.cookies.set('plansync-user', '', { path: '/', maxAge: 0 });
  return response;
}
