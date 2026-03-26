'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { versions, type DocVersion } from '@/content/docs/versions';
import { DocsMarkdownRenderer } from './docs-markdown-renderer';
import { ChevronRight, BookOpen, FileText } from 'lucide-react';

interface DocsViewerProps {
  version: string;
  slug: string[];
}

export function DocsViewer({ version: initialVersion, slug }: DocsViewerProps) {
  const router = useRouter();
  const [currentVersion, setCurrentVersion] = useState(initialVersion);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);

  const selectedVersion = versions.find(v => v.id === currentVersion) || versions[0];
  const currentPageSlug = slug.length > 0 ? slug.join('/') : 'overview';
  const currentPage = selectedVersion.pages.find(p => p.slug === currentPageSlug) || selectedVersion.pages[0];

  // Change version
  const handleVersionChange = (newVersion: string) => {
    const newSlug = slug[0] === currentVersion ? [newVersion, ...slug.slice(1)] : [newVersion, ...slug];
    router.push(`/docs/${newSlug.join('/')}`);
  };

  // Load markdown content
  useEffect(() => {
    const loadContent = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/content/docs/${currentVersion}/${currentPage.file}`);
        if (res.ok) {
          const text = await res.text();
          setContent(text);
        } else {
          setContent(`# ${currentPage.title}\n\nContent not found.`);
        }
      } catch {
        setContent(`# ${currentPage.title}\n\nFailed to load content.`);
      } finally {
        setLoading(false);
      }
    };
    loadContent();
  }, [currentVersion, currentPage.file, slug]);

  // Update local state if prop changes
  useEffect(() => {
    setCurrentVersion(initialVersion);
  }, [initialVersion]);

  return (
    <div className="flex flex-col lg:flex-row gap-8 p-6 max-w-7xl mx-auto">
      {/* Sidebar */}
      <div className="lg:w-64 flex-shrink-0">
        <div className="sticky top-6">
          <div className="mb-6">
            <label className="block text-sm font-medium mb-2">Version</label>
            <select
              className="w-full px-3 py-2 border border-border rounded-lg bg-card text-sm"
              value={currentVersion}
              onChange={(e) => handleVersionChange(e.target.value)}
            >
              {versions.map(v => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground mt-2">
              {selectedVersion.description}
            </p>
          </div>

          <nav className="space-y-1">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              Contents
            </h3>
            {selectedVersion.pages.map(page => (
              <Link
                key={page.slug}
                href={`/docs/${currentVersion}/${page.slug}`}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                  currentPage.slug === page.slug
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                }`}
              >
                <FileText className="w-4 h-4" />
                {page.title}
              </Link>
            ))}
          </nav>

          <div className="mt-8 pt-6 border-t border-border">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              Resources
            </h3>
            <a
              href="https://clawhub.ai/skills/emperor-claw-os"
              target="_blank"
              className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <BookOpen className="w-4 h-4" />
              ClawHub Skill
            </a>
            <a
              href="https://docs.openclaw.ai"
              target="_blank"
              className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <BookOpen className="w-4 h-4" />
              OpenClaw Docs
            </a>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0">
        <div key={`${currentVersion}-${currentPage.slug}`} className="card p-8">
          <div className="mb-6 flex items-center text-sm text-muted-foreground">
            <Link href="/docs" className="hover:text-foreground transition-colors">
              Documentation
            </Link>
            <ChevronRight className="w-4 h-4 mx-2" />
            <span className="font-medium">{selectedVersion.label}</span>
            <ChevronRight className="w-4 h-4 mx-2" />
            <span className="text-foreground">{currentPage.title}</span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-center">
                <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin mx-auto mb-4"></div>
                <p className="text-muted-foreground">Loading documentation...</p>
              </div>
            </div>
          ) : (
            <DocsMarkdownRenderer content={content} />
          )}
        </div>

        <div className="mt-8 flex justify-between border-t border-border pt-6">
          <div>
            <p className="text-sm text-muted-foreground">
              Need help? Join the{' '}
              <a href="https://discord.com/invite/clawd" className="text-primary hover:underline" target="_blank">
                Discord community
              </a>
              .
            </p>
          </div>
          <div className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} Emperor Claw • UI matches Emperor Web
          </div>
        </div>
      </div>
    </div>
  );
}