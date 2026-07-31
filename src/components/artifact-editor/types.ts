export type OfficeEditorHandle = {
    exportBlob: () => Promise<Blob>;
    markSaved: () => void;
};

export type OfficeEditorProps = {
    bytes: ArrayBuffer;
    fileName: string;
    onDirtyChange: (dirty: boolean) => void;
    onHandleChange: (handle: OfficeEditorHandle | null) => void;
};

