// Типы для API Chromium, которых нет в стандартной библиотеке TypeScript.

interface FileSystemHandlePermissionDescriptor {
    mode?: "read" | "readwrite";
}

interface FileSystemHandle {
    queryPermission?(d?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission?(d?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

interface DocumentPictureInPicture extends EventTarget {
    requestWindow(options?: { width?: number; height?: number; disallowReturnToOpener?: boolean }): Promise<Window>;
    readonly window: Window | null;
}

interface Window {
    showDirectoryPicker?(options?: { id?: string; mode?: "read" | "readwrite"; startIn?: string }): Promise<FileSystemDirectoryHandle>;
    documentPictureInPicture?: DocumentPictureInPicture;
}
