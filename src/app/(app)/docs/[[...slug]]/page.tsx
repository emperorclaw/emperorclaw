import { DocsViewer } from '@/components/docs-viewer';
import { versions } from '@/content/docs/versions';

export default function DocsPage({ params }: { params: { slug?: string[] } }) {
  const slug = params.slug || [];
  const version = slug[0] && versions.find(v => v.id === slug[0]) ? slug[0] : 'v1.1';
  const pageSlug = slug[0] === version ? slug.slice(1) : slug;

  return <DocsViewer version={version} slug={pageSlug} />;
}

export async function generateStaticParams() {
  const paths: { slug: string[] }[] = [];

  // Root docs page
  paths.push({ slug: [] });

  // Each version root
  versions.forEach(version => {
    paths.push({ slug: [version.id] });
  });

  // Each page in each version (simplified – in reality you'd read file system)
  versions.forEach(version => {
    version.pages.forEach(page => {
      paths.push({ slug: [version.id, page.slug] });
    });
  });

  return paths;
}