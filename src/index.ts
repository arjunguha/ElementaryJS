// This module is the entrypoint of the ElementaryJS package. It is written
// for both Node and web browsers. i.e., it does not provide functions to
// read code from files.
import * as babel from 'babel-core';
import { Node, Program } from 'babel-types';
import * as babylon from 'babylon';
import * as visitor from './visitor';
import { CompileOK, CompileError, CompilerOpts, Result } from './types';
export { CompileOK, CompileError, CompilerOpts, Result } from './types';
import { polyfillHofFromAst } from '@stopify/higher-order-functions';
import * as stopify from '@stopify/stopify';
import * as runtime from './runtime';
import * as interpreter from '@stopify/project-interpreter';

/* tslint:disable:no-var-requires */
// NOTE(arjun): This may not be needed, but I am using require instead of the
// name so that Webpack can statically link.
const transformArrowFunctions = require('babel-plugin-transform-es2015-arrow-functions'),
      transformClasses = require('babel-plugin-transform-es2015-classes');
/* tslint:enable:no-var-requires */

// TODO(arjun): I think these hacks are necessary for eval to work. We either
// do them here or we do them within the implementation of Stopify. I want
// them here for now until I'm certain there isn't a cleaner way.
const theGlobal: any = (typeof window !== 'undefined') ? window : global;
theGlobal.elementaryJS = runtime;
theGlobal.stopify = stopify;

class ElementaryRunner implements CompileOK {
  public g: { [key: string]: any };
  public kind: 'ok' = 'ok';
  private codeMap: { [key: string]: any };
  private ejsOff: boolean;

  constructor(private runner: stopify.AsyncRun & stopify.AsyncEval, opts: CompilerOpts) {
    this.ejsOff = opts.ejsOff as boolean;
    if (this.ejsOff) { runtime.disableEJS(); }

    this.codeMap = {};
    const config: string = `{
      getRunner: runtime.getRunner,
      stopifyArray: runtime.stopifyArray,
      stopifyObjectArrayRecur: runtime.stopifyObjectArrayRecur
    }`;
    Object.keys(opts.whitelistCode).forEach((moduleName: string) => {
      // tslint:disable-next-line:no-eval
      this.codeMap[moduleName] = eval(`(${opts.whitelistCode[moduleName]}(${config}))`);
    });

    const JSONStopfied = Object.assign({}, JSON);
    JSONStopfied.parse = (text: string) => runtime.stopifyObjectArrayRecur(JSON.parse(text));

    const globals = {
      elementaryjs: runtime,
      console: Object.freeze({
        log: (message: string) => opts.consoleLog(message)
      }),
      test: runtime.test,
      assert: runtime.assert,
      // TODO: Remove `lib220` as a part of '/issues/156'.
      lib220: Object.freeze(this.codeMap.lib220),
      ocelot: Object.freeze(this.codeMap.lib220),
      version: opts.version,
      Array: runtime.Array,
      Math: Math,
      undefined: undefined,
      Infinity: Number.POSITIVE_INFINITY,
      Object: Object, // Needed for classes
      parseInt: Number.parseInt,
      parseFloat: Number.parseFloat,
      hire: this.codeMap.oracle.hire,
      wheat1: this.codeMap.oracle.wheat1,
      chaff1: this.codeMap.oracle.chaff1,
      JSON: JSONStopfied,
      parser: Object.freeze({
        parseProgram: (input: string) => runtime.stopifyObjectArrayRecur(interpreter
          .parseProgram(input)),
        parseExpression: (input: string) => runtime.stopifyObjectArrayRecur(interpreter
          .parseExpression(input))
      }),
      geometry: Object.freeze({
        Point: this.codeMap.rrt.Point,
        Line: this.codeMap.rrt.Line,
        intersects: this.codeMap.rrt.intersects
      }),
      require: (lib: string): any => {
        if (this.codeMap[lib]) {
          return Object.freeze(this.codeMap[lib]);
        }
        runtime.errorHandle(`'${lib}' not found.`, 'require');
      }
    };

    // We can use .get and .set traps to intercept reads and writes to
    // global variables. Any other trap is useless (I think), since Stopify
    // does not use the global object in any other way.
    const globalProxy = new Proxy(Object.assign({}, globals), { // prevent altering globals
      get: (o, k) => {
        if (!Object.hasOwnProperty.call(o, k)) {
          runtime.errorHandle(`${String(k)} is not defined`, 'globalProxy');
        }
        return (o as any)[k];
      },
      set: (obj, prop, value) => {
        if (globals.hasOwnProperty(prop)) { // if it's a global variable
          runtime.errorHandle(
            `${prop as string} is part of the global library, and cannot be overwritten.`,
            'globalProxy');
        }
        return Reflect.set(obj, prop, value); // set value
      }
    });

    runtime.setRunner(runner);
    runner.g = globalProxy;
    this.g = runner.g;
  }

  run(onDone: (result: Result) => void) {
    const eRunner = runtime.getRunner();
    if (eRunner.kind !== 'ok') {
      throw Error('Invalid runner in run');
    }
    eRunner.value.isRunning = true;
    this.runner.run((result: Result) => {
      eRunner.value.isRunning = false;
      onDone(result);
    });
  }

  eval(code: string, onDone: (result: Result) => void) {
    const elementary = applyElementaryJS(code, this.ejsOff);
    if (elementary.kind === 'error') {
      return onDone({
        type: 'exception',
        stack: [],
        value: elementary.errors.map(e => `Line ${e.line}: ${e.message}`).join('\n')
      });
    }
    const eRunner = runtime.getRunner();
    if (eRunner.kind !== 'ok') {
      throw Error('Invalid runner in eval');
    }
    eRunner.value.isRunning = true;
    this.runner.evalAsyncFromAst(elementary.ast, (result: Result) => {
      eRunner.value.isRunning = false;
      onDone(result);
    });
  }

  stop(onStopped: () => void) {
    const eRunner = runtime.getRunner();
    if (eRunner.kind !== 'ok') {
      throw Error('Invalid runner in stop');
    }
    eRunner.value.isRunning = false;
    eRunner.value.onStopped = onStopped;
    this.runner.pause(() => {
      onStopped();
    });
  }
}

function applyElementaryJS(code: string | Node, ejsOff: boolean):
  CompileError | { kind: 'ok', ast: Program } {
  try {
    // Babylon is the parser that Babel uses internally.
    const ast = typeof code === 'string' ? babylon.parse(code).program : code,
          result1 = babel.transformFromAst(ast, typeof code === 'string' && code || undefined, {
            plugins: [ transformArrowFunctions, [ visitor.plugin(ejsOff) ] ]
          }),
          result2 = babel.transformFromAst(result1.ast!, result1.code!, {
            plugins: [ transformClasses ],
            code: false
          }),
          // NOTE(arjun): There is some imprecision in the type produced by Babel.
          // I have verified that this cast is safe.
          polyfilled = polyfillHofFromAst((result2.ast as babel.types.File).program);

    return {
      ast: polyfilled,
      kind: 'ok'
    };
  } catch (exn) {
    if (exn instanceof visitor.State) {
      return exn;
    }

    let line: number = 0,
        message: string = '';

    if (exn instanceof SyntaxError) {
      const groups = /^(.*) \((\d+):(\d+)\)$/.exec(exn.message);
      if (groups === null) {
        // NOTE(arjun): I don't think this can happen, but you never know with JavaScript.
        message = exn.message;
      } else {
        line = Number(groups[2]);
        message = groups[1];
      }
    } else if (exn.loc && exn.loc.line) { // This can happen due to Babel.
      line = Number(exn.loc.line);
      message = exn.message;
    } else {
      message = exn.message;
    }

    return {
      kind: 'error',
      errors: [ { line, message } ]
    };
  }
}

export function compile(code: string | Node, opts: CompilerOpts): CompileOK | CompileError {
  const elementary = applyElementaryJS(code, opts.ejsOff as boolean);
  if (elementary.kind === 'error') {
    return elementary;
  }

  const stopified = stopify.stopifyLocallyFromAst(elementary.ast);
  if (stopified.kind === 'error') {
    return {
      kind: 'error',
      errors: [ { line: 0, message: String(stopified.exception) } ]
    };
  }

  const runner: ElementaryRunner = new ElementaryRunner(stopified, opts);
  runner.g.$stopifyArray = function(array: any) {
    return require('@stopify/higher-order-functions/dist/ts/simpleHofPolyfill.lazy')
      .stopifyArray(array);
  }
  return runner;
}
