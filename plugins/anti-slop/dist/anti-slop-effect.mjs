// node_modules/@oxlint/plugins/index.js
function defineRule(rule) {
  return rule;
}
var EMPTY_VISITOR = {};
function eslintCompatPlugin(plugin) {
  if (typeof plugin != "object" || !plugin) throw Error("Plugin must be an object");
  let { rules } = plugin;
  if (typeof rules != "object" || !rules) throw Error("Plugin must have an object as `rules` property");
  let afterHooksState = new AfterHooksState();
  for (let ruleName in rules) Object.hasOwn(rules, ruleName) && convertRule(rules[ruleName], afterHooksState);
  return plugin;
}
var AfterHooksState = class {
  resetFunctions = [];
  pendingStates = [];
  pendingCount = 0;
  lintFinishedCount = 0;
  resetIsScheduled = false;
  sourceCode = null;
  resetMicrotask = this.resetMicrotaskImpl.bind(this);
  /**
  * Register a function to run `after` hook for a rule, and reset state.
  * @param reset - Function to run `after` hook and reset state
  * @returns Index of rule
  */
  registerResetFunction(reset) {
    let { pendingStates } = this, index = pendingStates.length;
    return pendingStates.push(0), this.resetFunctions.push(reset), index;
  }
  /**
  * Register that a rule with `after` hook has completed linting a file.
  * Called by `onCodePathEnd` CFG event handler which is added to visitor for rules with `after` hooks.
  *
  * If all rules with an `after` hook which needs to be run have completed linting the file, run all `after` hooks.
  */
  ruleFinished() {
    this.lintFinishedCount++, this.lintFinishedCount === this.pendingCount && this.reset(false);
  }
  /**
  * Call all reset functions where corresponding entry in `pendingStates` is `AFTER_HOOK_PENDING`.
  * Should only be called when some `after` hooks are pending.
  *
  * @param ignoreErrors - `true` to catch and silently ignore any errors which occur in `after` hooks.
  *   `false` to throw them,
  * @throws {unknown} If `ignoreErrors` is `false` and an error occurs in any `after` hooks.
  */
  reset(ignoreErrors) {
    this.pendingCount;
    let { resetFunctions, pendingStates } = this, hooksLen = pendingStates.length, hasError = false, error;
    for (let i = 0; i < hooksLen; i++) if (pendingStates[i] !== 0) {
      pendingStates[i] = 0;
      try {
        resetFunctions[i]();
      } catch (e) {
        hasError === false && (hasError = true, error = e);
      }
    }
    if (this.pendingCount = 0, this.lintFinishedCount = 0, this.sourceCode = null, hasError === true && ignoreErrors === false) throw error;
  }
  /**
  * Schedule a microtask to run `reset` functions.
  */
  scheduleReset() {
    queueMicrotask(this.resetMicrotask), this.resetIsScheduled = true;
  }
  /**
  * Function which is scheduled as the cleanup microtask.
  * `scheduleReset` uses `resetMicrotask` which is this method bound to `this`.
  */
  resetMicrotaskImpl() {
    this.resetIsScheduled = false, this.pendingCount !== 0 && this.reset(true);
  }
};
function convertRule(rule, afterHooksState) {
  if (typeof rule != "object" || !rule) throw Error("Rule must be an object");
  if ("create" in rule) return;
  let context = null, visitor, beforeHook, setupAfterHook;
  rule.create = (eslintContext) => {
    context === null && ({ context, visitor, beforeHook, setupAfterHook } = createContextAndVisitor(rule, afterHooksState));
    let eslintFileContext = Object.getPrototypeOf(eslintContext);
    if (setupAfterHook !== null) {
      let { sourceCode } = eslintFileContext;
      afterHooksState.sourceCode !== sourceCode && (afterHooksState.sourceCode = sourceCode, afterHooksState.pendingCount !== 0 && afterHooksState.reset(true));
    }
    return Object.defineProperties(context, {
      id: { value: eslintContext.id },
      options: { value: eslintContext.options },
      report: { value: eslintContext.report }
    }), Object.setPrototypeOf(context, eslintFileContext), beforeHook !== null && beforeHook() === false ? EMPTY_VISITOR : (setupAfterHook !== null && (setupAfterHook(eslintFileContext.sourceCode.ast), afterHooksState.resetIsScheduled === false && afterHooksState.scheduleReset()), visitor);
  };
}
var FILE_CONTEXT = Object.freeze({
  get filename() {
    throw Error("Cannot access `context.filename` in `createOnce`");
  },
  getFilename() {
    throw Error("Cannot call `context.getFilename` in `createOnce`");
  },
  get physicalFilename() {
    throw Error("Cannot access `context.physicalFilename` in `createOnce`");
  },
  getPhysicalFilename() {
    throw Error("Cannot call `context.getPhysicalFilename` in `createOnce`");
  },
  get cwd() {
    throw Error("Cannot access `context.cwd` in `createOnce`");
  },
  getCwd() {
    throw Error("Cannot call `context.getCwd` in `createOnce`");
  },
  get sourceCode() {
    throw Error("Cannot access `context.sourceCode` in `createOnce`");
  },
  getSourceCode() {
    throw Error("Cannot call `context.getSourceCode` in `createOnce`");
  },
  get languageOptions() {
    throw Error("Cannot access `context.languageOptions` in `createOnce`");
  },
  get settings() {
    throw Error("Cannot access `context.settings` in `createOnce`");
  },
  extend(extension) {
    return Object.freeze(Object.assign(Object.create(this), extension));
  },
  get parserOptions() {
    throw Error("Cannot access `context.parserOptions` in `createOnce`");
  },
  get parserPath() {
    throw Error("Cannot access `context.parserPath` in `createOnce`");
  }
});
function createContextAndVisitor(rule, afterHooksState) {
  let { createOnce } = rule;
  if (createOnce == null) throw Error("Rules must define either a `create` or `createOnce` method");
  if (typeof createOnce != "function") throw Error("Rule `createOnce` property must be a function");
  let context = Object.create(FILE_CONTEXT, {
    id: {
      value: null,
      enumerable: true,
      configurable: true
    },
    options: {
      value: null,
      enumerable: true,
      configurable: true
    },
    report: {
      value() {
        throw Error("Cannot report errors in `createOnce`");
      },
      enumerable: true,
      configurable: true
    }
  }), { before: beforeHook, after: afterHook, ...visitor } = createOnce.call(rule, context);
  if (beforeHook === void 0) beforeHook = null;
  else if (beforeHook !== null && typeof beforeHook != "function") throw Error("`before` property of visitor must be a function if defined");
  let setupAfterHook = null;
  if (afterHook != null) {
    if (typeof afterHook != "function") throw Error("`after` property of visitor must be a function if defined");
    let program = null, ruleIndex = afterHooksState.registerResetFunction(() => {
      program = null, afterHook();
    });
    setupAfterHook = (ast) => {
      program = ast, afterHooksState.pendingStates[ruleIndex] = 1, afterHooksState.pendingCount++;
    };
    let onCodePathEnd = visitor.onCodePathEnd;
    visitor.onCodePathEnd = onCodePathEnd == null ? function(_codePath, node) {
      node === program && afterHooksState.ruleFinished();
    } : function(codePath, node) {
      onCodePathEnd.call(this, codePath, node), node === program && afterHooksState.ruleFinished();
    };
  }
  return {
    context,
    visitor,
    beforeHook,
    setupAfterHook
  };
}

// tools/oxlint/anti-slop/effect/shared/tagged-values.ts
var equalityOperators = /* @__PURE__ */ new Set(["==", "===", "!=", "!=="]);
var broadEffectCatchMethods = /* @__PURE__ */ new Set(["catch", "catchAll", "catchIf"]);
var isStringLiteral = (node) => node?.type === "Literal" && typeof node.value === "string";
var isTagMember = (node) => node?.type === "MemberExpression" && (!node.computed && node.property.type === "Identifier" && node.property.name === "_tag" || node.computed && isStringLiteral(node.property) && node.property.value === "_tag");
var tagMemberFromComparison = (node) => {
  if (!equalityOperators.has(node.operator)) return void 0;
  if (isTagMember(node.left) && isStringLiteral(node.right)) return node.left;
  if (isTagMember(node.right) && isStringLiteral(node.left)) return node.right;
  return void 0;
};
var isBroadEffectCatchCall = (node) => node?.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.object.type === "Identifier" && node.callee.object.name === "Effect" && !node.callee.computed && node.callee.property.type === "Identifier" && broadEffectCatchMethods.has(node.callee.property.name);
var isInsideBroadEffectHandler = (node) => {
  let current = node.parent;
  while (current !== null && current !== void 0) {
    if (current.type === "ArrowFunctionExpression" || current.type === "FunctionExpression") {
      return isBroadEffectCatchCall(current.parent) && current.parent.arguments.includes(current);
    }
    current = current.parent;
  }
  return false;
};
var isReasonTagMember = (node) => node.object.type === "MemberExpression" && (!node.object.computed && node.object.property.type === "Identifier" && node.object.property.name === "reason" || node.object.computed && isStringLiteral(node.object.property) && node.object.property.value === "reason");
var propertyName = (property) => {
  if (!property.computed && property.key.type === "Identifier") {
    return property.key.name;
  }
  if (property.key.type === "Literal" && typeof property.key.value === "string") {
    return property.key.value;
  }
  return void 0;
};
var isMatchPatternObject = (node) => {
  const call = node.parent;
  if (call?.type !== "CallExpression" || !call.arguments.includes(node)) {
    return false;
  }
  const callee = call.callee;
  return callee.type === "MemberExpression" && callee.object.type === "Identifier" && callee.object.name === "Match" && !callee.computed && callee.property.type === "Identifier" && (callee.property.name === "when" || callee.property.name === "not");
};

// tools/oxlint/anti-slop/effect/rules/no-manual-effect-error-tag.ts
var noManualEffectErrorTagRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Use Effect tagged error handlers instead of manually branching on `_tag` in a catch handler."
    },
    messages: {
      tag: "Use Effect.catchTag or Effect.catchTags instead of manually discriminating a tagged error in a broad Effect catch handler.",
      reason: "Use Effect.catchReason or Effect.catchReasons instead of manually discriminating a tagged `reason` in a broad Effect catch handler."
    }
  },
  createOnce(context) {
    return {
      BinaryExpression(node) {
        const tagMember = tagMemberFromComparison(node);
        if (tagMember === void 0 || !isInsideBroadEffectHandler(node)) {
          return;
        }
        context.report({
          node,
          messageId: isReasonTagMember(tagMember) ? "reason" : "tag"
        });
      },
      SwitchStatement(node) {
        if (!isTagMember(node.discriminant) || !isInsideBroadEffectHandler(node)) {
          return;
        }
        context.report({
          node,
          messageId: isReasonTagMember(node.discriminant) ? "reason" : "tag"
        });
      }
    };
  }
});

// tools/oxlint/anti-slop/effect/rules/no-manual-tag-comparison.ts
var noManualTagComparisonRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Use Effect Match or Predicate helpers instead of manually branching on `_tag`."
    },
    messages: {
      manualComparison: "Use Match.tag/Match.tags for tagged-value branching, or Predicate.isTagged for a simple reusable predicate.",
      manualSwitch: "Use Match.value(value).pipe(Match.tag/Match.tags/Match.tagsExhaustive) or the tagged enum `$match` helper instead of switching on `_tag`."
    }
  },
  createOnce(context) {
    return {
      BinaryExpression(node) {
        if (tagMemberFromComparison(node) === void 0 || isInsideBroadEffectHandler(node)) {
          return;
        }
        context.report({ node, messageId: "manualComparison" });
      },
      SwitchStatement(node) {
        if (!isTagMember(node.discriminant) || isInsideBroadEffectHandler(node)) {
          return;
        }
        context.report({ node, messageId: "manualSwitch" });
      }
    };
  }
});

// tools/oxlint/anti-slop/effect/rules/no-manual-tagged-construction.ts
var noManualTaggedConstructionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Construct tagged values with their existing Effect constructor instead of writing `_tag` manually."
    },
    messages: {
      manualConstruction: "Use the existing Schema tagged `.make`, tagged class/error constructor, or Data.taggedEnum variant constructor instead of writing a literal `_tag` object."
    }
  },
  createOnce(context) {
    return {
      ObjectExpression(node) {
        if (isMatchPatternObject(node)) return;
        const tag = node.properties.find(
          (property) => property.type === "Property" && propertyName(property) === "_tag" && isStringLiteral(property.value)
        );
        if (tag !== void 0) {
          context.report({ node: tag, messageId: "manualConstruction" });
        }
      }
    };
  }
});

// tools/oxlint/anti-slop/effect/rules/no-service-constructor-imports.ts
var SERVICE_CONSTRUCTOR_NAME = /^make[A-Z]/u;
var TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
function isProjectLocalImport(source) {
  return source.startsWith("./") || source.startsWith("../");
}
function getImportedName(specifier) {
  if (specifier.imported.type === "Identifier") return specifier.imported.name;
  return specifier.imported.value;
}
var noServiceConstructorImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow project-local make<CapabilityName> imports outside test and spec files."
    },
    messages: {
      serviceConstructorImport: 'Do not import Effect service constructor "{{name}}" into runtime code. Import the owning Layer, yield the contextual service, and allow its requirements to propagate to the composition root.'
    }
  },
  create(context) {
    const isTestFile = TEST_FILE.test(context.filename.replaceAll("\\", "/"));
    return {
      ImportDeclaration(node) {
        if (isTestFile || !isProjectLocalImport(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;
          const importedName = getImportedName(specifier);
          if (!SERVICE_CONSTRUCTOR_NAME.test(importedName)) continue;
          context.report({
            node: specifier,
            messageId: "serviceConstructorImport",
            data: { name: importedName }
          });
        }
      }
    };
  }
});

// tools/oxlint/anti-slop/effect/rules/prefer-effect-match.ts
var equalityOperators2 = /* @__PURE__ */ new Set(["==", "===", "!=", "!=="]);
var preferEffectMatchRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Use Match from Effect for chained literal ternaries over the same value."
    },
    messages: {
      preferMatch: "Use Match from Effect instead of a chained literal ternary."
    }
  },
  createOnce(context) {
    const isLiteral = (node) => node.type === "Literal" || node.type === "TemplateLiteral" && node.expressions.length === 0;
    const comparedValue = (node) => {
      if (node.type !== "BinaryExpression" || !equalityOperators2.has(node.operator)) {
        return void 0;
      }
      if (isLiteral(node.left)) return context.sourceCode.getText(node.right);
      if (isLiteral(node.right)) return context.sourceCode.getText(node.left);
      return void 0;
    };
    return {
      ConditionalExpression(node) {
        if (node.parent?.type === "ConditionalExpression") return;
        const value = comparedValue(node.test);
        if (value === void 0) return;
        let alternate = node.alternate;
        let literalChecks = 1;
        while (alternate.type === "ConditionalExpression") {
          if (comparedValue(alternate.test) !== value) return;
          literalChecks += 1;
          alternate = alternate.alternate;
        }
        if (literalChecks > 1) {
          context.report({ node, messageId: "preferMatch" });
        }
      }
    };
  }
});

// tools/oxlint/anti-slop/effect/index.ts
var antiSlopEffectPlugin = eslintCompatPlugin({
  meta: { name: "anti-slop-effect" },
  rules: {
    "no-manual-effect-error-tag": noManualEffectErrorTagRule,
    "no-manual-tag-comparison": noManualTagComparisonRule,
    "no-manual-tagged-construction": noManualTaggedConstructionRule,
    "no-service-constructor-imports": noServiceConstructorImportsRule,
    "prefer-effect-match": preferEffectMatchRule
  }
});
var index_default = antiSlopEffectPlugin;
export {
  index_default as default
};
