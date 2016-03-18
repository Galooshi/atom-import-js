'use strict';

const getEnv = require('consistent-env').async;
const BufferedProcess = require('atom').BufferedProcess;
const CompositeDisposable = require('atom').CompositeDisposable;

const AskForSelectionView = require('./AskForSelectionView');

getEnv();

/**
 * @return {String}
 */
function getCurrentWorkingDirectory() {
  const currentPath = atom.workspace.getActiveTextEditor().buffer.file.path;
  const paths = atom.project.getPaths();
  return paths.find(path => currentPath.startsWith(path));
}

/**
 * @param {Array} args
 * @return {Promise}
 */
function exec(args) {
  return new Promise((resolve, reject) => {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) {
      reject(new Error('Could not get active text editor'));
    }

    const allArgs = [
      '--stdin-file-path', editor.buffer.file.path,
    ].concat(args || []);

    const result = {};

    getEnv().then(env => {
      const processOptions = {
        command: atom.config.get('atom-import-js.binary'),
        args: allArgs,
        options: {
          cwd: getCurrentWorkingDirectory(),
          env,
        },

        /**
        * We abuse stderr to pass messages back to the editor via a JSON blob.
        * Here we want to parse them out and display them to the user.
        * @param {String} data
        */
        stderr(data) {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch (error) {
            result.error = {
              error,
              output: data,
            };
          }

          if (parsed) {
            Object.assign(result, parsed);
          }
        },

        /**
        * We expect the new file contents to come back via stdout.
        * @param {String} data
        */
        stdout(data) {
          result.output = data;
        },

        /**
        * @param {Number} code
        */
        exit(code) {
          if (code === 0) {
            resolve(result);
          }
          reject(new Error(`Exited with code ${code}`), result);
        },
      };

      const spawnedProcess = new BufferedProcess(processOptions);
      spawnedProcess.onWillThrowError((error) => {
        atom.notifications.addError('import-js', {
          detail: error,
        });
        reject(error, result);
      });

      const currentFileContents = editor.getText();
      spawnedProcess.process.stdin.write(currentFileContents);
      spawnedProcess.process.stdin.end();
    });
  }); // new Promise
}

/**
 * @return {String} The word under the cursor
 */
function getCurrentWord() {
  const editor = atom.workspace.getActiveTextEditor();
  if (!editor) {
    return undefined;
  }

  const cursor = editor.getLastCursor();
  if (!cursor) {
    return undefined;
  }

  const wordRange = cursor.getCurrentWordBufferRange();
  return editor.getTextInBufferRange(wordRange);
}

/**
 * @param {Array<Object>} selectionsToAskFor
 * @param {Array<Object>} previousSelections
 */
function askForSelections(selectionsToAskFor, previousSelections) {
  const selections = previousSelections || [];

  if (selectionsToAskFor.length === 0) {
    // We have no more selections to ask for, so we can wrap it up!
    if (selections.length === 0) {
      // No selections were chosen.
      return undefined;
    }

    importSelections(selections); // eslint-disable-line no-use-before-define
    return undefined;
  }

  // Ask for the next selection
  const selectionToAskFor = selectionsToAskFor.shift();

  // TODO show what word we are asking for
  const askView = new AskForSelectionView();
  askView.setItems(selectionToAskFor.alternatives);
  askView.show();
  askView.deferred
    .then((alternativeIndex) => {
      const selection = {
        word: selectionToAskFor.word,
        alternativeIndex,
      };

      return selections.concat([selection]);
    })
    // Selection was cancelled, so let's just move on.
    .catch(() => selections)
    .then((newSelections) => {
      askView.destroy();
      askForSelections(selectionsToAskFor, newSelections);
    });

  return undefined;
}

/**
 * @param {Object} result
 */
function processResultMessages(result) {
  if (result.messages) {
    // TODO come up with a better solution for this potential wall of text that
    // can happen when fixing a lot of imports.
    atom.notifications.addSuccess(result.messages);
  }
}

/**
 * @param {Object} result
 */
function handleExecResult(result) {
  if (result.ask_for_selections) {
    askForSelections(result.ask_for_selections, []);
    return;
  }

  const editor = atom.workspace.getActiveTextEditor();
  if (editor.getText() !== result.output) {
    editor.buffer.setTextViaDiff(result.output);
  }

  processResultMessages(result);
}

/**
 * @param {Error} error
 * @param {Object} result
 */
function handleExecError(error, result) {
  const message = result ? result.error.output : error.toString();
  atom.notifications.addError(message);
  throw error;
}

function importWord() {
  const word = getCurrentWord();
  if (!word) {
    return;
  }

  exec(['--word', word])
    .then(handleExecResult)
    .catch(handleExecError);
}

function fixImports() {
  exec()
    .then(handleExecResult)
    .catch(handleExecError);
}

/**
 * @param {Array<Object>} selections
 */
function importSelections(selections) {
  // Foo:0,Bar:1
  const selectionsString = selections
    .map((selection) => `${selection.word}:${selection.alternativeIndex}`)
    .join(',');

  const args = ['--selections', selectionsString];

  // TODO we shouldn't need to include --word, but with the way that the CLI
  // currently works, we do need to include it.
  if (selections.length === 1) {
    args.push('--word', selections[0].word);
  }

  exec(args)
    .then(handleExecResult)
    .catch(handleExecError);
}


function gotoWord() {
  const word = getCurrentWord();
  if (!word) {
    return;
  }

  exec(['--word', word, '--goto'])
    .then((result) => {
      const path = `${getCurrentWorkingDirectory()}/${result.output}`;
      atom.open({ pathsToOpen: [path], newWindow: false });

      processResultMessages(result);
    })
    .catch(handleExecError);
}

const ImportJS = {
  config: {
    binary: {
      title: 'Binary path',
      description: 'Path for import-js',
      type: 'string',
      default: 'import-js',
      order: 1,
    },
  },

  subscriptions: null,

  activate() {
    this.subscriptions = new CompositeDisposable;
    this.subscriptions.add(atom.commands.add('atom-workspace', {
      'import-js:import': () => importWord(),
      'import-js:goto': () => gotoWord(),
      'import-js:fix-imports': () => fixImports(),
    }));
  },

  /**
   * @return {*}
   */
  deactivate() {
    this.subscriptions.dispose();
  },

  /**
   * @return {Object}
   */
  serialize() {
    return {};
  },
};

module.exports = ImportJS;
