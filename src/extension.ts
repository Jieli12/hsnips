import * as vscode from 'vscode';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'fs';
import * as path from 'path';
import openExplorer = require('open-file-explorer');
import { HSnippet } from './hsnippet';
import { HSnippetInstance } from './hsnippetInstance';
import { parse } from './parser';
import { getOldGlobalSnippetDir, getSnippetDirInfo, SnippetDirType } from './utils';
import { getCompletions, CompletionInfo } from './completion';
import { COMPLETIONS_TRIGGERS } from './consts';

const SNIPPETS_BY_LANGUAGE: Map<string, HSnippet[]> = new Map();
const SNIPPET_STACK: HSnippetInstance[] = [];

let insertingSnippet = false;
let snippetDirWatcher: vscode.FileSystemWatcher | undefined;
let loadSnippetsTimeout: NodeJS.Timeout | undefined;

/**
 * 加载snippet文件，增强错误处理和日志记录
 * @param context VS Code扩展上下文
 * @param retryCount 重试次数，用于处理依赖扩展未就绪的情况
 */
async function loadSnippets(context: vscode.ExtensionContext, retryCount = 0) {
  try {
    console.log(`[HSnips] Loading snippets... (attempt ${retryCount + 1})`);
    SNIPPETS_BY_LANGUAGE.clear();

    const snippetDirInfo = getSnippetDirInfo(context);
    if (snippetDirInfo === null) {
      console.log('[HSnips] No snippet directory info available');
      return;
    }

    const snippetDirPath = snippetDirInfo.path;
    console.log(`[HSnips] Snippet directory: ${snippetDirPath}`);

    if (!existsSync(snippetDirPath)) {
      console.log(`[HSnips] Creating snippet directory: ${snippetDirPath}`);
      mkdirSync(snippetDirPath, { recursive: true });
    }

    const files = readdirSync(snippetDirPath);
    const hsnipFiles = files.filter(file => path.extname(file).toLowerCase() === '.hsnips');

    console.log(`[HSnips] Found ${hsnipFiles.length} .hsnips files: ${hsnipFiles.join(', ')}`);

    for (let file of hsnipFiles) {
      try {
        let filePath = path.join(snippetDirPath, file);
        let fileData = readFileSync(filePath, 'utf8');
        let language = path.basename(file, '.hsnips').toLowerCase();

        const snippets = parse(fileData);
        SNIPPETS_BY_LANGUAGE.set(language, snippets);
        console.log(`[HSnips] Loaded ${snippets.length} snippets from ${file} for language: ${language}`);
      } catch (error) {
        console.error(`[HSnips] Error loading snippet file ${file}:`, error);
        vscode.window.showErrorMessage(`Failed to load snippet file ${file}: ${error}`);
      }
    }

    let globalSnippets = SNIPPETS_BY_LANGUAGE.get('all');
    if (globalSnippets) {
      console.log(`[HSnips] Applying ${globalSnippets.length} global snippets to all languages`);
      for (let [language, snippetList] of SNIPPETS_BY_LANGUAGE.entries()) {
        if (language !== 'all') snippetList.push(...globalSnippets);
      }
    }

    // Sort snippets by descending priority.
    for (let snippetList of SNIPPETS_BY_LANGUAGE.values()) {
      snippetList.sort((a, b) => b.priority - a.priority);
    }

    console.log(`[HSnips] Successfully loaded snippets for ${SNIPPETS_BY_LANGUAGE.size} languages`);

    // 设置文件系统监视器
    setupSnippetDirWatcher(context, snippetDirPath);

  } catch (error) {
    console.error('[HSnips] Error in loadSnippets:', error);

    // 如果是依赖扩展未就绪，尝试重试
    if (retryCount < 3 && error instanceof Error &&
      (error.message.includes('hscopes') || error.message.includes('extension'))) {
      console.log(`[HSnips] Retrying snippet loading in 1 second (attempt ${retryCount + 1})`);

      // 清除之前的超时
      if (loadSnippetsTimeout) {
        clearTimeout(loadSnippetsTimeout);
      }

      loadSnippetsTimeout = setTimeout(() => {
        loadSnippets(context, retryCount + 1);
      }, 1000);
      return;
    }

    vscode.window.showErrorMessage(`Failed to load HSnips: ${error}`);
  }
}

/**
 * 设置snippet目录的文件系统监视器
 * @param context VS Code扩展上下文
 * @param snippetDirPath snippet目录路径
 */
function setupSnippetDirWatcher(context: vscode.ExtensionContext, snippetDirPath: string) {
  // 清理之前的监视器
  if (snippetDirWatcher) {
    snippetDirWatcher.dispose();
  }

  try {
    // 创建监视器，监视.hsnips文件的变化
    const pattern = new vscode.RelativePattern(snippetDirPath, '*.hsnips');
    snippetDirWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    // 文件创建事件
    snippetDirWatcher.onDidCreate((uri) => {
      console.log(`[HSnips] New snippet file created: ${uri.fsPath}`);
      vscode.window.showInformationMessage(`HSnips: New snippet file detected - ${path.basename(uri.fsPath)}`);
      loadSnippets(context);
    });

    // 文件删除事件
    snippetDirWatcher.onDidDelete((uri) => {
      console.log(`[HSnips] Snippet file deleted: ${uri.fsPath}`);
      vscode.window.showInformationMessage(`HSnips: Snippet file removed - ${path.basename(uri.fsPath)}`);
      loadSnippets(context);
    });

    // 文件修改事件
    snippetDirWatcher.onDidChange((uri) => {
      console.log(`[HSnips] Snippet file changed: ${uri.fsPath}`);
      loadSnippets(context);
    });

    // 将监视器添加到订阅列表中，确保扩展卸载时清理
    context.subscriptions.push(snippetDirWatcher);

    console.log(`[HSnips] File system watcher set up for: ${snippetDirPath}`);
  } catch (error) {
    console.error('[HSnips] Failed to setup file system watcher:', error);
  }
}

/**
 * 清理资源
 */
function cleanup() {
  if (snippetDirWatcher) {
    snippetDirWatcher.dispose();
    snippetDirWatcher = undefined;
  }

  if (loadSnippetsTimeout) {
    clearTimeout(loadSnippetsTimeout);
    loadSnippetsTimeout = undefined;
  }
}

// This function may be called after a snippet expansion, in which case the original text was
// replaced by the snippet label, or it may be called directly, as in the case of an automatic
// expansion. Depending on which case it is, we have to delete a different editor range before
// triggering the real hsnip expansion.
export async function expandSnippet(
  completion: CompletionInfo,
  editor: vscode.TextEditor,
  snippetExpansion = false
) {
  // 验证 editor 和 document 的有效性
  if (!editor) {
    console.error('[HSnips] expandSnippet: editor is undefined');
    vscode.window.showErrorMessage('HSnips: No active editor found');
    return;
  }
  if (!editor.document) {
    console.error('[HSnips] expandSnippet: editor.document is undefined');
    vscode.window.showErrorMessage('HSnips: No active document found');
    return;
  }

  let snippetInstance = new HSnippetInstance(
    completion.snippet,
    editor,
    completion.range.start,
    completion.groups
  );

  let insertionRange: vscode.Range | vscode.Position = completion.range.start;

  // The separate deletion is a workaround for a VsCodeVim bug, where when we trigger a snippet which
  // has a replacement range, it will go into NORMAL mode, see issues #28 and #36.

  // TODO: Go back to inserting the snippet and removing in a single command once the VsCodeVim bug
  // is fixed.

  insertingSnippet = true;
  await editor.edit(
    (eb) => {
      eb.delete(snippetExpansion ? completion.completionRange : completion.range);
    },
    { undoStopAfter: false, undoStopBefore: !snippetExpansion }
  );

  await editor.insertSnippet(snippetInstance.snippetString, insertionRange, {
    undoStopAfter: false,
    undoStopBefore: false,
  });

  if (snippetInstance.selectedPlaceholder != 0) SNIPPET_STACK.unshift(snippetInstance);
  insertingSnippet = false;
}

export function activate(context: vscode.ExtensionContext) {
  console.log('[HSnips] Activating HyperSnips extension...');

  // 激活依赖扩展
  const hscopesExtension = vscode.extensions.getExtension('draivin.hscopes');
  if (hscopesExtension) {
    hscopesExtension.activate().then(() => {
      console.log('[HSnips] hscopes extension activated successfully');
    }, (error) => {
      console.error('[HSnips] Failed to activate hscopes extension:', error);
    });
  } else {
    console.warn('[HSnips] hscopes extension not found');
  }

  // 迁移旧目录
  const oldGlobalSnippetDir = getOldGlobalSnippetDir();
  if (existsSync(oldGlobalSnippetDir)) {
    console.log('[HSnips] Migrating from old global snippet directory...');
    const newSnippetDirInfo = getSnippetDirInfo(context, { ignoreWorkspace: true });

    if (newSnippetDirInfo.type == SnippetDirType.Global) {
      mkdirSync(path.dirname(newSnippetDirInfo.path), { recursive: true });
      renameSync(oldGlobalSnippetDir, newSnippetDirInfo.path);
      console.log('[HSnips] Successfully migrated old global snippet directory');
    }
  }

  // 延迟加载snippets，确保扩展完全激活
  setTimeout(() => {
    loadSnippets(context);
  }, 100);

  // 监听配置变化
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('hsnips.hsnipsPath') ||
        event.affectsConfiguration('hsnips.multiLineContext')) {
        console.log('[HSnips] Configuration changed, reloading snippets...');
        vscode.window.showInformationMessage('HSnips: Configuration changed, reloading snippets...');

        // 清理现有监视器
        if (snippetDirWatcher) {
          snippetDirWatcher.dispose();
          snippetDirWatcher = undefined;
        }

        // 重新加载snippets
        loadSnippets(context);
      }
    })
  );

  // 注册命令
  context.subscriptions.push(
    vscode.commands.registerCommand('hsnips.openSnippetsDir', () => {
      const snippetDirInfo = getSnippetDirInfo(context);
      openExplorer(snippetDirInfo.path);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hsnips.openSnippetFile', async () => {
      let snippetDirPath = getSnippetDirInfo(context).path;

      if (!existsSync(snippetDirPath)) {
        vscode.window.showWarningMessage('Snippet directory does not exist. Creating it now...');
        mkdirSync(snippetDirPath, { recursive: true });
        return;
      }

      let files = readdirSync(snippetDirPath).filter(f => f.endsWith('.hsnips'));

      if (files.length === 0) {
        vscode.window.showInformationMessage('No .hsnips files found in the snippet directory.');
        return;
      }

      let selectedFile = await vscode.window.showQuickPick(files);

      if (selectedFile) {
        let document = await vscode.workspace.openTextDocument(
          path.join(snippetDirPath, selectedFile)
        );
        vscode.window.showTextDocument(document);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hsnips.reloadSnippets', () => {
      console.log('[HSnips] Manual reload triggered');
      vscode.window.showInformationMessage('Reloading HSnips...');
      loadSnippets(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hsnips.leaveSnippet', () => {
      while (SNIPPET_STACK.length) SNIPPET_STACK.pop();
      vscode.commands.executeCommand('leaveSnippet');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hsnips.nextPlaceholder', () => {
      if (SNIPPET_STACK[0] && !SNIPPET_STACK[0].nextPlaceholder()) {
        SNIPPET_STACK.shift();
      }
      vscode.commands.executeCommand('jumpToNextSnippetPlaceholder');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hsnips.prevPlaceholder', () => {
      if (SNIPPET_STACK[0] && !SNIPPET_STACK[0].prevPlaceholder()) {
        SNIPPET_STACK.shift();
      }
      vscode.commands.executeCommand('jumpToPrevSnippetPlaceholder');
    })
  );

  // 监听hsnips文件保存事件
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.languageId === 'hsnips') {
        console.log(`[HSnips] Snippet file saved: ${document.fileName}`);
        loadSnippets(context);
      }
    })
  );

  // 注册扩展命令
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      'hsnips.expand',
      (editor, _, completion: CompletionInfo) => {
        expandSnippet(completion, editor, true);
      }
    )
  );

  // 文档内容变化监听器
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (SNIPPET_STACK.length && SNIPPET_STACK[0].editor.document === e.document) {
        SNIPPET_STACK[0].update(e.contentChanges);
      }

      if (insertingSnippet) return;

      if (e.contentChanges.length === 0) return;

      let mainChange = e.contentChanges[0];

      if (!mainChange) return;

      // 只处理单字符输入事件
      if (mainChange.text.length !== 1) return;

      let snippets = SNIPPETS_BY_LANGUAGE.get(e.document.languageId.toLowerCase());
      if (!snippets) snippets = SNIPPETS_BY_LANGUAGE.get('all');
      if (!snippets) return;

      let mainChangePosition = mainChange.range.start.translate(0, mainChange.text.length);
      let completions = getCompletions(e.document, mainChangePosition, snippets);

      // 自动完成匹配时展开snippet
      if (completions && !Array.isArray(completions)) {
        let editor = vscode.window.activeTextEditor;
        if (editor && editor.document && e.document === editor.document) {
          try {
            expandSnippet(completions, editor);
          } catch (error) {
            console.error('[HSnips] Error during automatic snippet expansion:', error);
            vscode.window.showErrorMessage(`HSnips: Failed to expand snippet - ${error}`);
          }
          return;
        }
      }
    })
  );

  // 清理过期的snippet实例
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => {
      while (SNIPPET_STACK.length) SNIPPET_STACK.pop();
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      while (SNIPPET_STACK.length) {
        if (e.selections.some((s) => SNIPPET_STACK[0].range.contains(s))) {
          break;
        }
        SNIPPET_STACK.shift();
      }
    })
  );

  // 注册补全提供器
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      [{ pattern: '**' }],
      {
        provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
          let snippets = SNIPPETS_BY_LANGUAGE.get(document.languageId.toLowerCase());
          if (!snippets) snippets = SNIPPETS_BY_LANGUAGE.get('all');
          if (!snippets) return;

          let completions = getCompletions(document, position, snippets);
          if (completions && Array.isArray(completions)) {
            return completions.map((c) => c.toCompletionItem());
          }
        },
      },
      ...COMPLETIONS_TRIGGERS
    )
  );

  console.log('[HSnips] HyperSnips extension activated successfully');
}

/**
 * 扩展停用时的清理函数
 */
export function deactivate() {
  console.log('[HSnips] Deactivating HyperSnips extension...');
  cleanup();
  console.log('[HSnips] HyperSnips extension deactivated');
}
