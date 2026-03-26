export interface DocPage {
  slug: string;
  title: string;
  file: string;
}

export interface DocVersion {
  id: string;
  label: string;
  description: string;
  pages: DocPage[];
}
