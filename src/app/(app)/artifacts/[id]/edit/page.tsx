import ArtifactOfficeEditor from "./artifact-office-editor";

export const dynamic = "force-dynamic";

export default async function ArtifactEditorPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return <ArtifactOfficeEditor artifactId={id} />;
}

