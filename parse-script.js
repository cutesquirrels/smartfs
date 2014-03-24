"use strict";
/**
 * This file is totally untidy. It contains, apart from the parser, the means to:
 * - convert a script's parse tokens into an AST
 * - resolve variables against builtin and configured symbols
 * - run script ASTs blocks in a stack-like environment
 * This file also contains a default configuration, bringing an in-memory key/val
 * store and an RSS feed fetcher.
 * Also an HTTP listener for "listen" blocks.
 * Also an implementation of every call issued in the "news" script.
 *
 * TODO: clean this up.
 */

const feedRead = require('feed-read');

const fs = require('fs');
if(process.argv.length == 2) {
  console.log("Usage: " + process.argv.slice(0, 2).join(' ') + " <script>");
  process.exit(127);
}

const input = fs.createReadStream(process.argv[2]);

const BUILTINS = {
  day: { value: 24 * 3600 * 1000 }, // ms in a day
  hour: { value: 3600 * 1000 },
  minute: { value: 60 * 1000 },
  desc: { value: 'desc' },
  asc: { value: 'asc' }
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST'
};

let buf = '';

input.on('data', function(chunk) {
  buf += chunk;
});

input.on('end', function() {

  /**
   * Type: context
   * Property: type
   * Property: name
   * Property: statements
   *
   * Type: block
   * Property: references (in occurrence order)
   * Property: calls (in statement order, may be nulled-out)
   * Property: timer (associated timer options)
   *
   * Type: reference
   * Property: type (value | call)
   * Property: symbol
   * Property: statement (index)
   * Property: arg (index)
   * (Property: call) (optional associated call)
   *
   * Type: call
   * Property: name (== reference.symbol)
   * Property: args
   *
   *
   */

  let contexts = [];
  let context = null;

  function pushContext(ctx) {
    if(context) {
      contexts.push(context);
    }
    context = ctx || null;
  }

  buf.split('\n').forEach(function(line, lineNo) {
    let md;
    line = line.split('#')[0];
    if(line.match(/^\s*$/)) {
      // empty, ignore.
    } else if((md = line.match(/^(task|background|action|define|listen)(.*)$/))) {
      let keyword = md[1], name = null;
      if(! md[2].match(/:$/)) {
        throw new Error("Expected block begin after keyword '" + keyword + "'!");
      }
      if((md = md[2].slice(0, -1).match(/\"(.+)\"/))) {
        name = md[1];
      }
      pushContext({ type: keyword, name: name, statements: [] });
    } else if(line.match(/^  (.+)$/)) {
      if(! context) {
        throw new Error("Statement without context in line " + (lineNo + 1) + "!");
      }
      let statement = line.slice(2);
      if(statement.match(/^\s/)) {
        throw new Error("Faulty indentation in line " + (lineNo + 1) + "!");
      }
      let tokens = [], tokenBuf = '';
      let string = false;
      function emitSymbol() {
        let token = {};
        if(tokenBuf.match(/^\d+$/)) {
          token.type = 'integer';
          token.value = parseInt(tokenBuf);
        } else if(tokenBuf.match(/^[\d\.]+$/)) {
          token.type = 'float';
          token.value = parseFloat(tokenBuf);
        } else if(tokenBuf.match(/^(?:true|false)$/)) {
          token.type = 'boolean';
          token.value = (tokenBuf === 'true');
        } else {
          token.type = 'symbol';
          token.value = tokenBuf;
        }
        tokens.push(token);
      }
      for(let i = 0, n = statement.length; i < n; i++) {
        let c = statement[i];
        if(c === '"') {
          if(string) {
            string = false;
            tokens.push({ type: 'string', value: tokenBuf });
            tokenBuf = '';
          } else if(tokenBuf.length > 0) {
            throw new Error("Unexpected string begin at " + (lineNo + 1) + ":" + (i + 2) + "!");
          } else {
            string = true;
          }
        } else if(c == ' ' && (! string)) {
          if(tokenBuf.length > 0) {
            emitSymbol();
            tokenBuf = '';
          }
        } else {
          tokenBuf += c;
        }
      }
      if(tokenBuf.length > 0) {
        emitSymbol();
      }
      context.statements.push(tokens);
    } else {
      throw new Error("Unmatched line " + lineNo);
    }
  });
  if(context) {
    pushContext();
  }

  console.log('parse result', JSON.stringify(contexts, null, 2));

  let script = evalScript(contexts);
  resolveSymbols(script);

  let sources = [
    {
      url: "http://blog.fefe.de/rss.xml?html",
      trustedHTML: true
    },
    {
      url: "http://www.tagesschau.de/xml/rss2"
    }
  ];

  runScript(script, {
    sources: sources.map(function(source) {
      return {
        fetch: function(callback) {
          feedRead(source.url, function(err, entries) {
            let result = {
              source: source
            };
            if(err) {
              console.log("Failed to get entries from feed: " + err);
              result.entries = [];
            } else {
              result.entries = entries;
            }
            result.entries.forEach(function(entry) {
              if(source.trustedHTML) {
                entry.contentHTML = entry.content;
              } else {
                entry.contentHTML = entry.content.replace(/<[^>]+>/g, '');
              }
            });
            callback(result);
          });
        }
      };
    }),
    news: {
      items: [],
      store: function(item, callback) {
        let key = item._id || this.items.length;
        this.items[key] = item;
        callback(key);
      },
      load: function(callback) {
        callback(this.items.slice());
      },
      loadItem: function(key, callback) {
        callback(this.items[parseInt(key)]);
      }
    }
  });
});

function runScript(script, config) {
  for(var key in config) {
    let variable = script.variables[key];
    if(variable) {
      variable.value = config[key];
    } else {
      throw new Error("Undeclared variable specified in configuration: " + key);
    }
  }
  verifyScript(script);
  script.background.forEach(function(block, i) {
    setTimeout(runBlock, 0, block, script, console.log.bind(console, "Background job", i, "terminated."));
  });
  script.listeners.forEach(function(listener, i) {
    switch(listener.protocol) {
    case 'http':
      if(typeof(listener.port) !== 'number') {
        throw new Error("Missing port number for http listener!");
      }
      require('http').createServer(function(req, res) {
        switch(req.method) {
        case 'OPTIONS':
          res.writeHead(204, CORS_HEADERS);
          res.end();
          break;
        case 'POST':
          {
            let args = req.url.slice(1).split('/'), action = args.shift();
            let actionBlock = script.actions[action];
            if(actionBlock) {
              runBlock(actionBlock, script, function(stack) {
                res.writeHead(200, {
                  'Content-Type': 'application/json',
                  'Access-Control-Allow-Origin': '*',
                  'Access-Control-Allow-Methods': 'POST'
                });
                res.write(JSON.stringify(stack, null, 2) + "\n");
                res.end();
              }, args);
            } else {
              res.writeHead(500, CORS_HEADERS);
              res.write("Unknown action: " + action + "\n");
              res.write("Have: " + JSON.stringify(Object.keys(script.actions)) + "\n");
              res.end();
            }
          }
          break;
        default:
          res.writeHead(400, CORS_HEADERS);
          res.write("Bad method!\n");
          res.end();
        }
      }).listen(listener.port);
      break;
    default:
      throw new Error("Unknown protocol: " + listener.protocol);
    }
  });
}

function runBlock(block, script, done, args) {
  // program counter
  let callIndex = 0;
  // stack management
  let stack = [];
  let PUSH = function(value) {
    if(typeof(value) === 'undefined') {
      throw new Error("PUSHED undefined!");
    }
    console.log('PUSH', typeof(value));
    stack.push(value);
  };
  let POP = function() {
    let value = stack.pop();
    if(typeof(value) === 'undefined') {
      throw new Error("Stack empty!");
    }
    console.log('POP', typeof(value));
    return value;
  };
  let POPLIST = function() {
    let value = POP();
    return (value instanceof Array) ? value : [value];
  };
  // push block arguments (as passed to actions)
  if(args) {
    args.forEach(PUSH);
  }
  if(block.timer) {
    // schedule block to be run
    if(typeof(block.timer.interval) !== 'undefined') {
      console.log('run every', block.timer.interval);
      setInterval(runCall, refValue(block.timer.interval, block));
      runCall();
    } else {
      setTimeout(runCall, refValue(block.timer.interval, block, 0));
    }
  } else {
    // run block now
    runCall();
  }
  function runCall() {
    if(callIndex === block.calls.length) {
      done(stack);
      return;
    }
    let call = block.calls[callIndex++];
    let next = setTimeout.bind(global, runCall, 0);
    if(! call) {
      next();
      return;
    }
    console.log('NEXT');
    for(let a = (call.args.length - 1); a >= 0; a--) {
      PUSH(refValue(call.args[a], block));
    }
    switch(call.name) {
    case 'run-task':
      {
        let taskName = POP();
        let task = script.tasks[taskName];
        if(task) {
          console.log('RUN TASK', taskName);
          runBlock(task, script, next);
        } else {
          throw new Error("Task not found: " + task);
        }
      }
      break;
    case 'fetch':
      {
        let sources = POPLIST();
        console.log('FETCH SOURCES', sources);
        let accumulator = function(result) {
          this.push(result);
          if(this.length == sources.length) {
            PUSH(this);
            next();
          }
        }.bind([]);
        sources.forEach(function(source) {
          source.fetch(accumulator);
        });
      }
      break;
    case 'extract-feed-entries':
      {
        console.log('EXTRACT FEED ENTRIES');
        PUSH(POP().reduce(function(entries, feed) {
          return entries.concat(feed.entries);
        }, []));
        next();
      }
      break;
    case 'set-flag':
      {
        console.log('SET FLAG');
        let key = POP(); //refValue(call.args[0], block);
        let value = POP(); //refValue(call.args[1], block);
        PUSH(POPLIST().map(function(record) {
          record[key] = value;
          return record;
        }));
        next();
      }
      break;
    case 'persist':
      {
        console.log('PERSIST');
        let datastore = POP(), records = POPLIST();
        let accumulator = function(record, key) {
          record._id = key;
          this.push(record);
          if(this.length === records.length) {
            PUSH(this);
            next();
          }
        }.bind([]);
        records.forEach(function(record) {
          datastore.store(record, accumulator.bind(this, record));
        });
      }
      break;
    case 'load':
      {
        console.log('LOAD');
        let datastore = POP();
        datastore.load(function(records) {
          PUSH(records);
          next();
        });
      }
      break;
    case 'load-item':
      {
        console.log('LOAD ITEM');
        let datastore = POP();
        let key = POP();
        if(typeof(key) !== 'string') {
          console.log('key', key);
          throw new Error("Invalid key :" + key + "!");
        }
        datastore.loadItem(key, function(record) {
          PUSH(record);
          next();
        });
      }
      break;
    case 'sort-by':
      {
        let field = POP();
        let direction = POP();
        let sorter = (
          direction === 'asc'
            ? function(_a, _b) {
              let a = _a[field], b = _b[field];
              if(typeof(a) == 'undefined' || typeof(b) == 'undefined') {
                return 0;
              }
              return a > b ? -1 : a < b ? 1 : 0;
            }
          : function(_a, _b) {
            let a = _a[field], b = _b[field];
            if(typeof(a) == 'undefined' || typeof(b) == 'undefined') {
              return 0;
            }
            return a < b ? -1 : a > b ? 1 : 0;
          }
        );
        PUSH(POPLIST().sort(sorter));
        next();
      }
      break;
    case 'filter':
      {
        let field = POP();
        let value = POP();
        PUSH(POPLIST().filter(function(item) {
          return item[field] === value;
        }));
        next();
      }
      break;
    default:
      console.log('STUB STATEMENT', call.name, call.args);
      next();
    }
  }
}

function verifyScript(script) {
  for(let name in script.tasks) {
    verifyBlock(script, script.tasks[name], "task", name);
  }
  script.background.forEach(function(block, i) {
    verifyBlock(script, block, " background", "#" + (i + 1));
  });
  for(let name in script.actions) {
    verifyBlock(script, script.actions[name], "action", name);
  }

  function verifyBlock(script, block, blockDesc, name) {
    block.references.forEach(function(reference) {
      if(reference.source && reference.source.required && (! reference.source.value)) {
        throw new Error("Variable not set: " + reference.symbol + " (required by: " + blockType + " " + name + ")");
      }
    });
  }
}

function findRef(symbol, block) {
  for(let i = 0, n = block.references.length; i < n; i++) {
    if(block.references[i].symbol === symbol) {
      return block.references[i];
    }
  }
  throw new Error("Reference not found in block: " + symbol);
}

function refValue(valueOrToken, block, defaultValue) {
  if(typeof(valueOrToken) === 'object' && valueOrToken.type === 'symbol') {
    let ref = findRef(valueOrToken.value, block);
    if(ref.source) {
      if(typeof(ref.source.value) === 'undefined') {
        if(typeof(defaultValue) === 'undefined') {
          throw new Error("Reference value not set: " + ref.symbol);
        } else {
          return defaultValue; // referenced value not found, but default given
        }
      } else {
        return ref.source.value; // referenced value found (such as with builtin)
      }
    }
  } else {
    return valueOrToken; // value wasn't a reference
  }
}

function evalScript(contexts) {
  let script = {
    variables: {},
    tasks: {},
    actions: {},
    background: [],
    listeners: []
  };
  contexts.forEach(function(context) {
    switch(context.type) {
    case 'define':
      script.variables[context.name] = evalDefinition(context.statements, {
        type: { type: 'symbol' },
        required: { type: 'boolean', emptyValue: true }
      });
      break;
    case 'listen':
      script.listeners.push(evalDefinition(context.statements, {
        protocol: { type: 'symbol' },
        address: { type: 'string' },
        port: { type: 'integer' }
      }));
      break;
    case 'task':
      script.tasks[context.name] = evalBlock(context.statements);
      break;
    case 'action':
      script.actions[context.name] = evalBlock(context.statements);
      break;
    case 'background':
      script.background.push(evalBlock(context.statements));
      break;
    default:
      throw new Error("Invalid context type: " + context.type);
    }
  });
  return script;
}

function evalDefinition(statements, keywords) {
  let definition = {};
  statements.forEach(function(statement) {
    let first = statement[0], second = statement[1];
    expectTokenType('symbol', first);
    let keyword = keywords[first.value];
    if(keyword) {
      if(keyword.emptyValue && (! second)) {
        definition[first.value] = keyword.emptyValue;
      } else {
        if(keyword.type) {
          expectTokenType(keyword.type, second);
        }
        definition[first.value] = second.value;
      }
    } else {
      throw new Error("Unknown statement keyword for definition: " + first.value);
    }
  });
  return definition;
}

function evalBlock(statements) {
  let block = {
    references: [],
    calls: []
  };
  statements.forEach(function(statement, statementIndex) {
    let first = statement[0];
    expectTokenType('symbol', first);
    block.references.push({
      type: 'call',
      symbol: first.value,
      statement: statementIndex
    });
    block.calls.push({
      name: first.value,
      args: statement.slice(1).map(function(arg, argIndex) {
        if(arg.type === 'symbol') {
          block.references.push({
            type: 'value',
            symbol: arg.value,
            statement: statementIndex,
            arg: argIndex
          });
          return arg;
        } else {
          return arg.value;
        }
      })
    });
  });
  return block;
}

function expectTokenType(type, token) {
  if(token.type !== type) {
    throw new Error("Unexpected token '" + token.type + "', expected '" + type + "'!");
  }
}

function resolveSymbols(script) {
  for(let name in script.tasks) {
    resolveBlockSymbols(script, script.tasks[name], "task", name);
  }
  script.background.forEach(function(block, i) {
    resolveBlockSymbols(script, block, " background", "#" + (i + 1));
  });
  for(let name in script.actions) {
    resolveBlockSymbols(script, script.actions[name], "action", name);
  }
}

function resolveBlockSymbols(script, block, blockType, name) {
  function expectArgs(ref, n, types) {
    if(ref.call.args.length !== n) {
      throw new Error("Expected " + n + " arguments for statement " + (ref.statement + 1) + ", but got " + ref.call.args.length + " instead! (from: " + blockType + " " + name + ")");
    }
    if(types) {
      types.forEach(function(type, i) {
        if(typeof(ref.call.args[i]) !== type) {
          throw new Error("Expected argument #" + (i+1) + " to be of type " + type + ", but got " + typeof(ref.call.args[i]) + " instead in statement " + (ref.statement + 1)+ " (from: " + blockType + " " + name + ")");
        }
      });
    }
  }
  block.references.forEach(function(reference) {
    if(reference.type === 'call') {
      console.log('resolve call  ', reference.symbol);
      reference.call = block.calls[reference.statement];
      switch(reference.symbol) {
      case 'every':
        expectArgs(reference, 1);
        if(block.timer) {
          throw new Error("Duplicate timer in block: " + blockType + " " + name);
        }
        block.timer = { interval: reference.call.args[0] };
        block.calls[reference.statement] = null;
        break;
      case 'run-task':
        expectArgs(reference, 1, ['string']);
        break;
      case 'persist':
        expectArgs(reference, 1);
        break;
      case 'fetch':
        expectArgs(reference, 1);
        break;
      case 'set-flag':
        expectArgs(reference, 2, ['string']);
        break;
      case 'extract-feed-entries':
        expectArgs(reference, 0);
        break;
      default:
        console.log('ERROR: unknown call', reference.symbol);
      }
    } else if(reference.type === 'value') {
      reference.source = ( script.variables[reference.symbol] ||
                           BUILTINS[reference.symbol]);
      if(! reference.source) {
        throw new Error("Failed to resolve symbol \"" + reference.symbol + "\" (from: " + blockType + " " + name + ", statement #" + (reference.statement + 1) + (typeof(reference.arg) !== 'undefined' ? ", argument " + (reference.arg + 1) : "") + ")");
      }
      console.log('resolve symbol ' + reference.symbol + ' -> ' + JSON.stringify(reference.source));
    } else {
      throw new Error("BUG: invalid reference type: " + reference.type);
    }
  });
}
