/**
 * Host half of the dsh-workspace-files-tree bundle.
 *
 * The plugin is pure browser UI: the file tree renders in the Web GUI through
 * the client module declared by package.json `dsh.client`, and reads the
 * workspace over the existing `workspaceFiles` Remote namespace. The Host row
 * therefore contributes nothing to the Host Cordis tree.
 */
export function apply() {}
