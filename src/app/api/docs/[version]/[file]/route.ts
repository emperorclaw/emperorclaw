import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ version: string; file: string }> }
) {
  const { version, file } = await params;

  // Security: only allow .md files
  if (!file.endsWith('.md')) {
    return NextResponse.json({ error: 'Invalid file' }, { status: 400 });
  }

  // Security: prevent directory traversal
  if (version.includes('..') || file.includes('..')) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  try {
    const contentPath = join(process.cwd(), 'src', 'content', 'docs', version, file);
    const content = await readFile(contentPath, 'utf-8');
    return new NextResponse(content, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (error) {
    console.error('Failed to load docs file:', error);
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}