export interface DocPage {
  slug: string;
  title: string;
  file: string;
  /** Sidebar group; pages without one are listed under "More". */
  section?: DocSection;
}

export type DocSection = 'Getting Started' | 'Using Emperor' | 'Agent Runtimes' | 'Integrations & Reference';

export const DOC_SECTIONS: DocSection[] = ['Getting Started', 'Using Emperor', 'Agent Runtimes', 'Integrations & Reference'];

export interface DocVersion {
  id: string;
  label: string;
  description: string;
  pages: DocPage[];
}
