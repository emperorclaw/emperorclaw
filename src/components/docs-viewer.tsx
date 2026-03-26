'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { versions, type DocVersion } from '@/content/docs/versions';
import { DocsMarkdownRenderer } from './docs-markdown-renderer';
import { ChevronRight, BookOpen, FileText, Menu, X, ArrowLeft, ExternalLink } from 'lucide-react';
import { CustomLogo } from './custom-logo';

interface DocsViewerProps {
  version: string;
  slug: string[];
}

export function DocsViewer({ version: initialVersion, slug }: DocsViewerProps) {
  const router = useRouter();
  const [currentVersion, setCurrentVersion] = useState(initialVersion);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

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
        // Fix: Use API route instead of public folder
        const res = await fetch(`/api/docs/${currentVersion}/${currentPage.file}`);
        if (res.ok) {
          const text = await res.text();
          setContent(text);
        } else {
          setContent(`# ${currentPage.title}\n\nContent not found. Check if the file exists in the repository.`);
        }
      } catch {
        setContent(`# ${currentPage.title}\n\nFailed to load content from the server.`);
      } finally {
        setLoading(false);
        setMobileMenuOpen(false);
      }
    };
    loadContent();
  }, [currentVersion, currentPage.file, slug]);

  // Update local state if prop changes
  useEffect(() => {
    setCurrentVersion(initialVersion);
  }, [initialVersion]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 selection:bg-indigo-500/30">
      {/* Public Header */}
      <header className="sticky top-0 z-50 w-full border-b border-zinc-800/50 bg-zinc-950/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-3 group">
              <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 group-hover:border-indigo-500/40 transition-colors">
                <CustomLogo className="w-5 h-5 text-indigo-400" />
              </div>
              <span className="font-semibold text-lg tracking-tight hidden sm:block">Emperor Claw</span>
            </Link>
            <div className="h-4 w-px bg-zinc-800 mx-2 hidden sm:block" />
            <span className="text-zinc-400 font-medium text-sm">Documentation</span>
          </div>

          <div className="flex items-center gap-3">
            <Link 
              href="/"
              className="hidden md:flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-100 transition-colors px-3 py-1.5 rounded-lg hover:bg-zinc-900 border border-transparent hover:border-zinc-800"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Dashboard
            </Link>
            <button 
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="lg:hidden p-2 text-zinc-400 hover:text-zinc-100 bg-zinc-900 rounded-lg border border-zinc-800"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 lg:px-6">
        <div className="flex flex-col lg:flex-row gap-0 lg:gap-12 py-8">
          {/* Sidebar */}
          <aside className={`
            lg:w-64 flex-shrink-0 lg:block
            ${mobileMenuOpen ? 'block mb-8' : 'hidden'}
          `}>
            <div className="sticky top-24 space-y-8">
              <div>
                <label className="block text-xs font-semibold text-indigo-400 uppercase tracking-wider mb-3">
                  Version
                </label>
                <div className="relative group">
                  <select
                    className="w-full appearance-none px-3 py-2.5 border border-zinc-800 rounded-xl bg-zinc-900/50 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/40 transition-all hover:bg-zinc-900"
                    value={currentVersion}
                    onChange={(e) => handleVersionChange(e.target.value)}
                  >
                    {versions.map(v => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-zinc-500">
                    <ChevronRight className="w-4 h-4 rotate-90" />
                  </div>
                </div>
                <p className="text-xs text-zinc-500 mt-2 px-1 italic">
                  {selectedVersion.description}
                </p>
              </div>

              <nav className="space-y-6">
                <div>
                  <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-widest mb-4 px-1">
                    Introduction
                  </h3>
                  <div className="space-y-1">
                    {selectedVersion.pages.map(page => (
                      <Link
                        key={page.slug}
                        href={`/docs/${currentVersion}/${page.slug}`}
                        className={`flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-all duration-200 group ${
                          currentPage.slug === page.slug
                            ? 'bg-indigo-500/10 text-indigo-400 font-medium border border-indigo-500/20 shadow-[0_0_15px_rgba(99,102,241,0.1)]'
                            : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 border border-transparent'
                        }`}
                      >
                        <FileText className={`w-4 h-4 ${currentPage.slug === page.slug ? 'text-indigo-400' : 'text-zinc-500 group-hover:text-zinc-300'}`} />
                        {page.title}
                      </Link>
                    ))}
                  </div>
                </div>

                <div className="pt-6 border-t border-zinc-800/80">
                  <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-widest mb-4 px-1">
                    Community
                  </h3>
                  <div className="space-y-1">
                    <a
                      href="https://clawhub.ai/skills/emperor-claw-os"
                      target="_blank"
                      className="flex items-center justify-between px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 rounded-xl transition-all group"
                    >
                      <div className="flex items-center gap-3">
                        <BookOpen className="w-4 h-4 text-zinc-500 group-hover:text-zinc-300" />
                        ClawHub Skill
                      </div>
                      <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </a>
                    <a
                      href="https://docs.openclaw.ai"
                      target="_blank"
                      className="flex items-center justify-between px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 rounded-xl transition-all group"
                    >
                      <div className="flex items-center gap-3">
                        <BookOpen className="w-4 h-4 text-zinc-500 group-hover:text-zinc-300" />
                        OpenClaw Docs
                      </div>
                      <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </a>
                  </div>
                </div>
              </nav>
            </div>
          </aside>

          {/* Main content */}
          <main className="flex-1 min-w-0">
            <div className="mb-8 flex items-center gap-2 text-xs text-zinc-500 font-medium uppercase tracking-wider">
              <Link href="/docs" className="hover:text-indigo-400 transition-colors">Documentation</Link>
              <ChevronRight className="w-3 h-3" />
              <span>{selectedVersion.label}</span>
              <ChevronRight className="w-3 h-3" />
              <span className="text-zinc-300">{currentPage.title}</span>
            </div>

            <div className="bg-zinc-900/40 border border-zinc-800/60 rounded-3xl p-6 md:p-10 shadow-xl backdrop-blur-sm relative overflow-hidden group">
              {/* Subtle background glow */}
              <div className="absolute -top-24 -right-24 w-64 h-64 bg-indigo-500/5 blur-[100px] rounded-full pointer-events-none group-hover:bg-indigo-500/10 transition-colors duration-1000" />
              
              {loading ? (
                <div className="flex flex-col items-center justify-center py-24">
                  <div className="w-10 h-10 border-2 border-indigo-500/10 border-t-indigo-500 rounded-full animate-spin mb-6"></div>
                  <p className="text-zinc-400 animate-pulse font-medium tracking-wide">Syncing documentation...</p>
                </div>
              ) : (
                <div className="relative z-10">
                  <DocsMarkdownRenderer content={content} />
                </div>
              )}
            </div>

            <footer className="mt-12 pt-8 border-t border-zinc-800/50 flex flex-col md:flex-row justify-between items-center gap-4 text-zinc-500 text-sm">
              <p>
                Need help? Join the{' '}
                <a href="https://discord.com/invite/clawd" className="text-indigo-400 hover:text-indigo-300 font-medium transition-colors" target="_blank">
                  Discord community
                </a>
              </p>
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/50 shadow-[0_0_8px_rgba(16,185,129,0.4)]" />
                <span>© {new Date().getFullYear()} Emperor Claw • Performance v1.1.2</span>
              </div>
            </footer>
          </main>
        </div>
      </div>
    </div>
  );
}