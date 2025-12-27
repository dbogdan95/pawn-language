'use strict';

import {
  Position,
  DiagnosticSeverity,
  ParameterInformation,
  CompletionItem,
  CompletionItemKind,
  Hover,
  SignatureHelp,
  Location,
  Range
} from 'vscode-languageserver/node';

import * as StringHelpers from '../common/string-helpers';
import * as Types from './types';
import * as Helpers from './helpers';
import * as DM from './dependency-manager';
import { URI } from 'vscode-uri';

interface FindFunctionIdentifierResult {
  identifier: string;
  parameterIndex?: number;
}

interface SpecifierResults {
  isStatic: boolean;
  isPublic: boolean;
  isConst: boolean;
  isStock: boolean;

  position: number;
  wrongCombination: boolean;
}

interface IdentifierResults {
  token: string;
  position: number;
}

interface LocalValueInfo {
  range: Range;
  isConst: boolean;
  tag: string;
  labelAddition: string;
  assignedValue?: string;
}

// 1 = storage specifiers
// 2 = tag
// 3 = identifier
// 4 = parameters
const callableRegex = /((?:[A-Za-z_@][\w_@]*\s+)*)?([A-Za-z_@][\w_@]+\s*:\s*)?(?:\[[^\]]+\]\s*)*([A-Za-z_@][\w_@]+)\s*\((.*?)\)/;

let docComment = '';

function positionToIndex(content: string, position: Position) {
  let line = 0;
  let index = 0;
  while (line !== position.line) {
    if (content[index] === '\n') {
      ++line;
    }
    ++index;
  }

  return index + position.character;
}

function findFunctionIdentifier(content: string, cursorIndex: number): FindFunctionIdentifierResult {
  let index = cursorIndex - 1;
  let parenthesisDepth = 0;
  let identifier = '';
  let parameterIndex = 0;

  while (index >= 0) {
    // We surely know that we shouldn't search further if we encounter a semicolon
    if (content[index] === ';') {
      return { identifier: '' };
    }
    if (content[index] === ',' && parenthesisDepth === 0) {
      ++parameterIndex;
    }
    if (content[index] === ')') {
      // Ignore the next '(', it's a nested call
      ++parenthesisDepth;
      --index;
      continue;
    }
    if (content[index] === '(') {
      if (parenthesisDepth > 0) {
        --parenthesisDepth;
        --index;
        continue;
      }

      // Identifier preceding this '(' is the function we are looking for
      // Skip all whitespaces first
      while (StringHelpers.isWhitespace(content[--index])) {}
      // Copy the identifier
      while (index >= 0 && StringHelpers.isAlphaNum(content[index])) {
        identifier += content[index];
        --index;
      }
      // Remove all digits from the end, an identifier can't start with a digit
      let identIndex = identifier.length;
      while (--identIndex >= 0 && StringHelpers.isDigit(identifier[identIndex])) {}
      if (identIndex !== identifier.length - 1) {
        identifier = identifier.substring(0, identIndex + 1);
      }
      // Finally reverse it and return it
      return { identifier: StringHelpers.reverse(identifier), parameterIndex: parameterIndex };
    }

    --index;
  }

  return { identifier: '' };
}

function findIdentifierBehindCursor(content: string, cursorIndex: number): string {
  let index = cursorIndex - 1;
  let identifier = '';

  while (index >= 0) {
    if (StringHelpers.isAlphaNum(content[index])) {
      identifier += content[index];
      --index;
      continue;
    } else {
      // Reached the end of the identifier
      return normalizeIdentifier(StringHelpers.reverse(identifier));
    }
  }

  return '';
}

function findIdentifierAtCursor(content: string, cursorIndex: number): { identifier: string; isCallable: boolean } {
  let result = {
    identifier: '',
    isCallable: false
  };

  if (!StringHelpers.isAlphaNum(content[cursorIndex])) {
    return result;
  }
  // Identifier must begin with alpha
  if (cursorIndex === 0 && StringHelpers.isDigit(content[cursorIndex])) {
    return result;
  }
  if (cursorIndex > 0 && StringHelpers.isDigit(content[cursorIndex]) && StringHelpers.isWhitespace(content[cursorIndex - 1])) {
    return result;
  }

  let index = cursorIndex;
  // Copy from the left side of cursor
  while (index >= 0) {
    if (StringHelpers.isAlphaNum(content[index])) {
      result.identifier += content[index];
      --index;
      continue;
    } else {
      // Reached the end of the identifier
      // Reverse the left part
      result.identifier = StringHelpers.reverse(result.identifier);
      break;
    }
  }
  // Copy from the right side of cursor
  if (cursorIndex !== content.length - 1) {
    index = cursorIndex + 1;
    while (index < content.length) {
      if (StringHelpers.isAlphaNum(content[index])) {
        result.identifier += content[index];
        ++index;
        continue;
      } else {
        // Reached the end of the identifier
        // Try to figure out if it's a callable
        while (index < content.length && StringHelpers.isWhitespace(content[index])) {
          ++index;
        }
        if (content[index] === '(') {
          result.isCallable = true;
        }
        break;
      }
    }
  }

  result.identifier = normalizeIdentifier(result.identifier);
  return result;
}

function handleMultilineComments(lineContent: string, inComment: boolean): { content: string; inComment: boolean } {
  // Maybe this should just be a "copy characters until..." parser
  if (inComment === true) {
    const endCommentIndex = lineContent.indexOf('*/');
    if (endCommentIndex >= 0) {
      docComment += lineContent.substring(0, endCommentIndex + 2);
      return handleMultilineComments(lineContent.substring(endCommentIndex + 2), false);
    } else {
      docComment += lineContent + '\n';
    }
  } else {
    const commentIndex = lineContent.indexOf('/*');
    if (commentIndex >= 0) {
      docComment = '';
      const endCommentIndex = lineContent.indexOf('*/');
      if (endCommentIndex >= 0) {
        docComment = lineContent.substring(commentIndex, endCommentIndex + 2);
        return handleMultilineComments(lineContent.substring(0, commentIndex) + lineContent.substring(endCommentIndex + 2), false);
      } else {
        docComment = lineContent.substring(commentIndex) + '\n';
        return { content: lineContent.substring(0, commentIndex).trim(), inComment: true };
      }
    }
  }

  return { content: lineContent.trim(), inComment: inComment };
}

function handleComments(lineContent: string, inComment: boolean) {
  let commentIndex = lineContent.indexOf('//');
  if (commentIndex >= 0) {
    lineContent = lineContent.substring(0, commentIndex).trim();
  }

  return handleMultilineComments(lineContent, inComment);
}

function handleBracketDepth(lineContent: string): number {
  let bracketDepth = 0;
  let contentIndex = 0;

  while (contentIndex !== lineContent.length) {
    if (lineContent[contentIndex] === '{') ++bracketDepth;
    else if (lineContent[contentIndex] === '}') --bracketDepth;
    ++contentIndex;
  }

  return bracketDepth;
}

function readIdentifier(content: string, position: number): IdentifierResults {
  let token = '';

  // Skip whitespace first
  while (position !== content.length && content[position] !== ';' && StringHelpers.isWhitespace(content[position])) {
    ++position;
  }
  if (position === content.length || content[position] === ';') {
    // Reached the end
    return { token: '', position: content.length };
  }
  // Copy the identifier
  let checkFunc = StringHelpers.isAlpha;
  let firstPass = true;
  while (position !== content.length && content[position] !== ';' && checkFunc(content[position])) {
    token += content[position];
    ++position;

    if (firstPass === true) {
      firstPass = false;
      checkFunc = StringHelpers.isAlphaNum;
    }
  }
  if (content[position] === ';') {
    return { token: token, position: content.length }; // A little hack when we reach the semicolon
  }

  return { token: token, position: position };
}

function readSpecicifers(content: string, position: number, initialToken: string): SpecifierResults {
  let results = {
    isStatic: false,
    isPublic: false,
    isConst: false,
    isStock: false,

    position: position,
    wrongCombination: false
  };

  switch (initialToken) {
    case 'static':
      results.isStatic = true;
      break;
    case 'public':
      results.isPublic = true;
      break;
    case 'const':
      results.isConst = true;
      break;
    case 'stock':
      results.isStock = true;
  }

  let tr: IdentifierResults = undefined;
  let previousPosition;
  do {
    previousPosition = tr === undefined ? position : tr.position;
    tr = readIdentifier(content, previousPosition);
    switch (tr.token) {
      case 'static':
        if (results.isStatic || results.isPublic) {
          results.wrongCombination = true;
          break;
        }
        results.isStatic = true;
        break;
      case 'public':
        if (results.isPublic || results.isStatic) {
          results.wrongCombination = true;
          break;
        }
        results.isPublic = true;
        break;
      case 'const':
        if (results.isConst) {
          results.wrongCombination = true;
          break;
        }
        results.isConst = true;
        break;
      case 'stock':
        if (results.isStock) {
          results.wrongCombination = true;
          break;
        }
        results.isStock = true;
        break;
      case 'new':
        results.wrongCombination = true;
        break;
      default:
        results.position = previousPosition;
        tr = undefined;
        break;
    }
    // Can't have more specifiers after 'const' if it was the first one
    if (tr !== undefined && initialToken === 'const') {
      results.wrongCombination = true;
    }
  } while (tr !== undefined && results.wrongCombination !== true);

  if (results.wrongCombination === true) {
    results.position = tr.position;
  }

  return results;
}

function createValueLabel(identifier: string, tag: string, sr: SpecifierResults) {
  let label = '';

  if (sr.isPublic === true) {
    label += 'public ';
  }
  if (sr.isStatic === true) {
    label += 'static ';
  }
  if (sr.isStock === true) {
    label += 'stock ';
  }
  if (sr.isConst === true) {
    label += 'const ';
  }
  if (label === '') {
    label += 'new ';
  }
  if (tag !== '') {
    label += tag + ':';
  }
  label += identifier;

  return label;
}

function parseVariableListLine(
  lineContent: string,
  rawLine: string,
  lineIndex: number,
  fileUri: URI,
  sr: SpecifierResults | null,
  results: Types.ParserResults,
  startOffset: number
) {
  if (!sr) {
    return;
  }
  const content = lineContent.substring(startOffset);
  const parts = splitTopLevelComma(content);
  const baseOffset = rawLine.indexOf(lineContent);
  const base = (baseOffset >= 0 ? baseOffset : 0) + startOffset;

  parts.forEach((part) => {
    const text = part.text.trim();
    if (text.length === 0) {
      return;
    }
    const match = text.match(/^(?:([A-Za-z_@][\w_@]*)\s*:\s*)?([A-Za-z_@][\w_@]*)/);
    if (!match) {
      return;
    }
    const tag = match[1] ?? '';
    const identifier = match[2];
    const identifierIndex = part.text.indexOf(identifier);
    const offset = base + part.start;
    const startChar = identifierIndex >= 0 ? offset + identifierIndex : offset;
    const endChar = startChar + identifier.length;
    const assignedValue = sr.isConst ? extractAssignedValue(part.text) : null;
    const simpleValue = assignedValue && isSimpleDefineValue(assignedValue) ? assignedValue : undefined;

    results.values.push({
      identifier: identifier,
      label: createValueLabel(identifier, tag, sr),
      isConst: sr.isConst,
      assignedValue: simpleValue,
      file: fileUri,
      range: {
        start: { line: lineIndex, character: startChar },
        end: { line: lineIndex, character: endChar }
      },
      documentaton: docComment
    });

  });
}

function parseEnumLine(
  lineContent: string,
  rawLine: string,
  lineIndex: number,
  fileUri: URI,
  results: Types.ParserResults,
  enumName?: string
) {
  let content = lineContent;
  const openIdx = content.indexOf('{');
  if (openIdx >= 0) {
    content = content.substring(openIdx + 1);
  }
  const closeIdx = content.indexOf('}');
  if (closeIdx >= 0) {
    content = content.substring(0, closeIdx);
  }

  const parts = splitTopLevelComma(content);
  const baseOffset = rawLine.indexOf(lineContent);
  const base = lineContent.length - content.length;
  parts.forEach((part) => {
    let text = part.text.trim();
    if (text.length === 0) {
      return;
    }
    const match = text.match(/^(?:[A-Za-z_@][\w_@]*\s*:\s*)?([A-Za-z_@][\w_@]*)/);
    if (!match) {
      return;
    }

    const identifier = match[1];
    const lineBase = baseOffset >= 0 ? baseOffset : 0;
    const offset = base + part.start;
    const startChar = rawLine.indexOf(identifier, lineBase + offset);
    const endChar = startChar >= 0 ? startChar + identifier.length : lineBase + offset + identifier.length;

    results.values.push({
      identifier: identifier,
      label: `const ${identifier}`,
      isConst: true,
      isEnumMember: true,
      enumGroup: enumName,
      file: fileUri,
      range: {
        start: { line: lineIndex, character: Math.max(0, startChar) },
        end: { line: lineIndex, character: Math.max(0, endChar) }
      },
      documentaton: docComment
    });
  });
}

function parseEnumName(lineContent: string, rawLine: string, lineIndex: number, fileUri: URI, results: Types.ParserResults): string | undefined {
  const match = lineContent.match(/^enum\s+(?:_?\s*:\s*)?([A-Za-z_@][\w_@]*)/);
  if (!match) {
    return undefined;
  }
  const name = match[1];
  const startChar = rawLine.indexOf(name);
  const endChar = startChar >= 0 ? startChar + name.length : name.length;

  results.values.push({
    identifier: name,
    label: `enum ${name}`,
    isConst: true,
    isEnumType: true,
    file: fileUri,
    range: {
      start: { line: lineIndex, character: Math.max(0, startChar) },
      end: { line: lineIndex, character: Math.max(0, endChar) }
    },
    documentaton: docComment
  });
  return name;
}

export function parse(fileUri: URI, content: string, skipStatic: boolean): Types.ParserResults {
  let results = new Types.ParserResults();
  let bracketDepth = 0; // We are searching only in the global scope
  let inComment = false;
  let inEnum = false;
  let enumDepth = 0;
  let enumAwaitBrace = false;
  let enumName: string | undefined;
  let inGlobalDecl = false;
  let globalDeclSpec: SpecifierResults | null = null;
  let globalDeclOffset = 0;
  let globalDeclLine: number | null = null;

  let lines = content.split(/\r?\n/);
  lines.forEach((rawLine, lineIndex) => {
    let lineContent = rawLine.trim();
    if (lineContent.length === 0) {
      return;
    }

    const commentsResult = handleComments(lineContent, inComment);
    lineContent = commentsResult.content;
    inComment = commentsResult.inComment;
    if (lineContent.length === 0) {
      return;
    }

    const depthBefore = bracketDepth;
    const depthAfter = bracketDepth + handleBracketDepth(lineContent);
    // Too many closing brackets, find excessive ones and report them
    if (depthAfter < 0) {
      let contentIndex = lineContent.length - 1;
      while (contentIndex >= 0) {
        if (lineContent[contentIndex] === '}') ++bracketDepth;
        if (bracketDepth === 0) {
          results.diagnostics.push({
            message: 'Unmatched closing brace',
            severity: DiagnosticSeverity.Error,
            source: 'amxxpawn',
            range: {
              start: { line: lineIndex, character: contentIndex },
              end: { line: lineIndex, character: contentIndex + 1 }
            }
          });

          return;
        }
        --contentIndex;
      }

      bracketDepth = 0; // Try to ignore it and continue parsing
      return;
    }
    bracketDepth = depthAfter;
    if (inEnum) {
      if (enumAwaitBrace) {
        if (lineContent.indexOf('{') < 0) {
          return;
        }
        enumAwaitBrace = false;
      }
      parseEnumLine(lineContent, rawLine, lineIndex, fileUri, results, enumName);
      if (depthAfter < enumDepth) {
        inEnum = false;
        enumDepth = 0;
        enumName = undefined;
      }
      return;
    }
    if (depthBefore > 0) {
      // Handle local scope (no implementation yet)
      return;
    }

    if (lineContent.length >= 6 && lineContent.substring(0, 6) === 'return') {
      return;
    }

    if (inGlobalDecl) {
      const startOffset = globalDeclLine === lineIndex ? globalDeclOffset : 0;
      parseVariableListLine(lineContent, rawLine, lineIndex, fileUri, globalDeclSpec, results, startOffset);
      globalDeclOffset = 0;
      if (lineContent.indexOf(';') >= 0) {
        inGlobalDecl = false;
        globalDeclSpec = null;
        globalDeclOffset = 0;
        globalDeclLine = null;
      }
      return;
    }

    // Handle preprocessor
    if (lineContent[0] === '#') {
      if (lineContent.substring(1, 8) === 'include' || lineContent.substring(1, 11) === 'tryinclude') {
        let isSilent = false;
        let startIndex = 8;
        if (lineContent.substring(1, 11) === 'tryinclude') {
          isSilent = true;
          startIndex = 11;
        }

        if (!StringHelpers.isWhitespace(lineContent[startIndex]) && lineContent[startIndex] !== '"' && lineContent[startIndex] !== '<') {
          return;
        }

        let charIndex = 0;
        let termCharacter: string;
        let filename = '';

        lineContent = lineContent.substring(startIndex);
        while (charIndex !== lineContent.length && StringHelpers.isWhitespace(lineContent[charIndex])) {
          ++charIndex;
        }
        if (lineContent[charIndex] === '"' || lineContent[charIndex] === '<') {
          termCharacter = lineContent[charIndex] === '"' ? '"' : '>';
          ++charIndex;
        } else {
          termCharacter = undefined;
        }

        while (lineContent[charIndex] !== termCharacter && charIndex !== lineContent.length) {
          filename += lineContent[charIndex++];
        }
        filename = filename.trim();

        if ((charIndex === lineContent.length && termCharacter !== undefined) || lineContent[charIndex] !== termCharacter) {
          results.diagnostics.push({
            message: 'The #include statement is not terminated properly',
            severity: DiagnosticSeverity.Error,
            source: 'amxxpawn',
            range: {
              start: { line: lineIndex, character: 0 },
              end: { line: lineIndex, character: startIndex + charIndex + 1 }
            }
          });

          return;
        }

        if (termCharacter !== undefined && charIndex !== lineContent.length - 1) {
          results.diagnostics.push({
            message: 'No extra characters are allowed after an #include statement',
            severity: DiagnosticSeverity.Error,
            source: 'amxxpawn',
            range: {
              start: { line: lineIndex, character: startIndex + charIndex + 1 },
              end: { line: lineIndex, character: Number.MAX_VALUE }
            }
          });

          return;
        }

        results.headerInclusions.push({
          filename: filename,
          isLocal: termCharacter !== '>',
          isSilent: isSilent,
          start: {
            line: lineIndex,
            character: 0
          },
          end: {
            line: lineIndex,
            character: startIndex + charIndex + 1
          }
        });
      }
      if (lineContent.substring(1, 7) === 'define') {
        let idx = 7;
        while (idx < lineContent.length && StringHelpers.isWhitespace(lineContent[idx])) {
          idx++;
        }
        const nameStart = idx;
        while (idx < lineContent.length && StringHelpers.isAlphaNum(lineContent[idx])) {
          idx++;
        }
        const macroName = lineContent.substring(nameStart, idx);
        if (macroName.length === 0) {
          return;
        }

        let params: ParameterInformation[] = [];
        if (idx < lineContent.length && lineContent[idx] === '(') {
          const closeIdx = lineContent.indexOf(')', idx + 1);
          if (closeIdx > idx) {
            const rawParams = lineContent.substring(idx + 1, closeIdx).trim();
            if (rawParams.length > 0) {
              params = rawParams.split(',').map((value) => ({ label: value.trim() }));
            }
          }
        }

        let value = '';
        if (params.length === 0 && idx < lineContent.length) {
          value = lineContent.substring(idx).trim();
          const lineComment = value.indexOf('//');
          if (lineComment >= 0) {
            value = value.substring(0, lineComment).trim();
          }
          const blockComment = value.indexOf('/*');
          if (blockComment >= 0) {
            value = value.substring(0, blockComment).trim();
          }
        }

        const isConstLike = params.length === 0 && isSimpleDefineValue(value);

        const macroDoc = isConstLike ? '' : docComment;
        results.callables.push({
          label: lineContent,
          identifier: macroName,
          isMacro: params.length > 0 || isConstLike,
          file: fileUri,
          start: {
            line: lineIndex,
            character: nameStart
          },
          end: {
            line: lineIndex,
            character: nameStart + macroName.length
          },
          parameters: params,
          documentaton: macroDoc
        });

        if (params.length === 0) {
          const label = value.length > 0 ? `#define ${macroName} ${value}` : `#define ${macroName}`;
          const assignedValue = isSimpleDefineValue(value) ? value : undefined;
          const inlineComment = extractInlineComment(rawLine);
          results.values.push({
            identifier: macroName,
            label: label,
            isConst: true,
            assignedValue: assignedValue,
            inlineComment: inlineComment,
            file: fileUri,
            range: {
              start: { line: lineIndex, character: nameStart },
              end: { line: lineIndex, character: nameStart + macroName.length }
            },
            documentaton: macroDoc
          });
        }
        docComment = '';
      }
    } else {
      if (lineContent.length >= 4 && lineContent.substring(0, 4) === 'enum') {
        enumName = parseEnumName(lineContent, rawLine, lineIndex, fileUri, results);
        if (lineContent.indexOf('{') >= 0) {
          inEnum = true;
          enumDepth = depthAfter;
          parseEnumLine(lineContent, rawLine, lineIndex, fileUri, results, enumName);
          if (lineContent.indexOf('}') >= 0) {
            inEnum = false;
            enumDepth = 0;
            enumName = undefined;
          }
        } else {
          inEnum = true;
          enumAwaitBrace = true;
          enumDepth = depthAfter + 1;
        }
        return;
      }
      if (lineContent.indexOf('(') < 0) {
        const tr = readIdentifier(lineContent, 0);
        if (tr.token !== '') {
          let sr: SpecifierResults = undefined;
          switch (tr.token) {
            case 'new':
            case 'static':
            case 'public':
            case 'stock':
            case 'const':
              sr = readSpecicifers(lineContent, tr.position, tr.token);
              break;
            default:
              sr = undefined;
              break;
          }
          if (sr !== undefined && sr.wrongCombination !== true) {
            const nextIdent = readIdentifier(lineContent, sr.position).token;
            const hasComma = lineContent.indexOf(',') >= 0;
            if (nextIdent === '' || hasComma) {
              inGlobalDecl = true;
              globalDeclSpec = sr;
              globalDeclOffset = sr.position;
              globalDeclLine = lineIndex;
              parseVariableListLine(lineContent, rawLine, lineIndex, fileUri, globalDeclSpec, results, globalDeclOffset);
              if (lineContent.indexOf(';') >= 0) {
                inGlobalDecl = false;
                globalDeclSpec = null;
                globalDeclOffset = 0;
                globalDeclLine = null;
              }
              return;
            }
          }
        }
      }
      if (lineContent.indexOf('(') >= 0 && lineContent.indexOf(')') >= 0) {
        const matches = lineContent.match(callableRegex);
        if (!matches || matches.index !== 0) {
          return;
        }

        if (matches[1] !== undefined) {
          if (skipStatic === true && matches[1].indexOf('static') >= 0) {
            return;
          }
        }

        let params: ParameterInformation[];
        if (matches[4].trim().length > 0) {
          params = matches[4].split(',').map((value) => ({ label: value.trim() }));
        } else {
          params = [];
        }

        results.callables.push({
          label: matches[0],
          identifier: matches[3],
          isMacro: false,
          file: fileUri,
          start: {
            line: lineIndex,
            character: matches.index
          },
          end: {
            line: lineIndex,
            character: matches[0].length
          },
          parameters: params,
          documentaton: docComment
        });
        docComment = '';
      } else {
        let tr = readIdentifier(lineContent, 0);
        if (tr.position === lineContent.length) {
          return;
        }

        let sr: SpecifierResults = undefined;
        switch (tr.token) {
          case 'new':
          case 'static':
          case 'public':
          case 'stock':
          case 'const':
            sr = readSpecicifers(lineContent, tr.position, tr.token);
            break;
          default:
            return;
        }
        if (sr.wrongCombination === true) {
          results.diagnostics.push({
            message: 'Invalid combination of class specifiers',
            severity: DiagnosticSeverity.Error,
            source: 'amxxpawn',
            range: {
              start: { line: lineIndex, character: 0 },
              end: { line: lineIndex, character: sr.position }
            }
          });
          return;
        }
        if (skipStatic && sr.isStatic) {
          return;
        }

        tr = readIdentifier(lineContent, sr.position);
        if (tr.token === '') {
          results.diagnostics.push({
            message: 'Expected an identifier',
            severity: DiagnosticSeverity.Error,
            source: 'amxxpawn',
            range: {
              start: { line: lineIndex, character: sr.position },
              end: { line: lineIndex, character: tr.position }
            }
          });
          return;
        }

        let symbol = tr.token;
        let symbolTag = '';

        if (tr.position !== lineContent.length) {
          let contentIndex = tr.position;
          while (contentIndex !== lineContent.length && StringHelpers.isWhitespace(lineContent[contentIndex])) {
            ++contentIndex;
          }
          if (lineContent[contentIndex] === ':') {
            symbolTag = symbol;
            tr = readIdentifier(lineContent, contentIndex + 1);
            if (tr.token !== '') {
              symbol = tr.token;
            } else {
              results.diagnostics.push({
                message: 'Expected an identifier',
                severity: DiagnosticSeverity.Error,
                source: 'amxxpawn',
                range: {
                  start: { line: lineIndex, character: contentIndex + 1 },
                  end: { line: lineIndex, character: tr.position }
                }
              });
            }
          }
        }

        let labelAddition = '';
        if (tr.position !== lineContent.length) {
          let contentIndex = tr.position;
          while (contentIndex !== lineContent.length && lineContent[contentIndex] !== ';' && lineContent[contentIndex] !== ',' && lineContent[contentIndex] !== '=') {
            labelAddition += lineContent[contentIndex++];
          }
        }

        const assignedValue = sr.isConst ? extractAssignedValue(lineContent) : null;
        const simpleValue = assignedValue && isSimpleDefineValue(assignedValue) ? assignedValue : undefined;
        results.values.push({
          identifier: symbol,
          label: createValueLabel(symbol, symbolTag, sr) + labelAddition,
          isConst: sr.isConst,
          assignedValue: simpleValue,
          file: fileUri,
          range: {
            start: { line: lineIndex, character: 0 },
            end: { line: lineIndex, character: tr.position }
          },
          documentaton: docComment
        });
      }
    }
  });

  return results;
}

export function doSignatures(content: string, position: Position, callables: Types.CallableDescriptor[]): SignatureHelp {
  const cursorIndex = positionToIndex(content, position);
  const result = findFunctionIdentifier(content, cursorIndex);

  if (result.identifier === '') {
    return null;
  }

  const callableIndex = callables.map((clb) => clb.identifier).indexOf(result.identifier);
  if (callableIndex < 0) {
    return null;
  }
  const callable = callables[callableIndex];

  if (callable.start.line === position.line) {
    return null;
  }

  return {
    activeSignature: 0,
    activeParameter: result.parameterIndex,
    signatures: [
      {
        label: callable.label,
        parameters: callable.parameters,
        documentation: callable.documentaton
      }
    ]
  };
}

export function doCompletions(
  content: string,
  position: Position,
  data: Types.DocumentData,
  dependenciesData: WeakMap<DM.FileDependency, Types.DocumentData>
): CompletionItem[] {
  const cursorIndex = positionToIndex(content, position);
  const identifier = findIdentifierBehindCursor(content, cursorIndex).toLowerCase();

  let callables: Types.CallableDescriptor[];
  let values: Types.ValueDescriptor[];
  if (identifier.length === 0) {
    return null;
  } else {
    const results = Helpers.getSymbols(data, dependenciesData);
    values = results.values.filter((val) => StringHelpers.fuzzy(val.identifier, identifier));
    callables = results.callables.filter((clb) => StringHelpers.fuzzy(clb.identifier, identifier));
  }

  // 21 is 'Constant'
  return values
    .map<CompletionItem>((val) => ({
      label: val.identifier,
      detail: val.label,
      kind: val.isConst ? (21 as CompletionItemKind) : CompletionItemKind.Variable,
      insertText: val.identifier[0] === '@' ? val.identifier.substr(1) : val.identifier,
      documentation: val.documentaton
    }))
    .concat(
      callables.map<CompletionItem>((clb) => ({
        label: clb.identifier,
        detail: clb.label,
        kind: CompletionItemKind.Function,
        insertText: clb.identifier[0] === '@' ? clb.identifier.substr(1) : clb.identifier,
        documentation: clb.documentaton
      }))
    );
}

export function doHover(
  content: string,
  position: Position,
  data: Types.DocumentData,
  dependenciesData: WeakMap<DM.FileDependency, Types.DocumentData>,
  options?: { showConstValues?: boolean; showDefineInlineComments?: boolean }
): Hover {
  const showConstValues = options?.showConstValues !== false;
  const showDefineInlineComments = options?.showDefineInlineComments !== false;
  const cursorIndex = positionToIndex(content, position);
  const result = findIdentifierAtCursor(content, cursorIndex);

  if (result.identifier.length === 0) {
    return null;
  }

  const symbols = Helpers.getSymbols(data, dependenciesData);
  if (result.isCallable) {
    const index = symbols.callables.map((clb) => clb.identifier).indexOf(result.identifier);
    if (index < 0) {
      return null;
    }
    const callable = symbols.callables[index];
    if (position.line === callable.start.line) {
      return null;
    }

    return {
      contents: [
        {
          language: 'amxxpawn',
          value: callable.label
        },
        {
          language: 'pawndoc',
          value: callable.documentaton
        }
      ]
    };
  } else {
    const localInfo = getLocalValueHoverInfo(content, position, result.identifier);
    if (localInfo) {
      if (position.line === localInfo.range.start.line) {
        return null;
      }
      const valueLine = localInfo.assignedValue ? `= ${localInfo.assignedValue}` : '';
      return {
        contents: [
          {
            language: 'amxxpawn',
            value: valueLine ? `${localInfo.label}${valueLine}` : localInfo.label
          }
        ]
      };
    }

    const index = symbols.values.map((val) => val.identifier).indexOf(result.identifier);
    if (index < 0) {
      return null;
    }
    const value = symbols.values[index];
    if (position.line === value.range.start.line) {
      return null;
    }
    const inlineComment = showDefineInlineComments ? (value.inlineComment ? value.inlineComment : '') : '';
    const docComment = value.label.startsWith('#define ') ? value.documentaton : '';
    const doc = docComment && inlineComment
      ? `${docComment}\n${inlineComment}`
      : (docComment || inlineComment);
    const valueLine = !showConstValues
      ? ''
      : (value.label.startsWith('#define ')
        ? ''
        : (value.assignedValue ? `= ${value.assignedValue}` : ''));

    return {
      contents: [
        {
          language: 'amxxpawn',
          value: valueLine ? `${value.label}${valueLine}` : value.label
        },
        {
          language: 'pawndoc',
          value: doc
        }
      ]
    };
  }
}

export function doDefinition(
  content: string,
  position: Position,
  data: Types.DocumentData,
  dependenciesData: WeakMap<DM.FileDependency, Types.DocumentData>
): Location {
  const cursorIndex = positionToIndex(content, position);

  // 1) Try resolving callback name inside string literal: "Ham_TakeDamage_Pre"
  const stringIdent = findIdentifierInsideStringLiteral(content, cursorIndex);
  if (stringIdent) {
    const symbols = Helpers.getSymbols(data, dependenciesData);
    const idx = symbols.callables.map((c) => c.identifier).indexOf(stringIdent);
    if (idx >= 0) {
      const callable = symbols.callables[idx];
      return Location.create(callable.file.toString(), Range.create(callable.start, callable.end));
    }
  }

  // 2) Fallback to normal identifier logic (existing behavior)
  const result = getIdentifierAtOrBehindCursor(content, cursorIndex);
  if (result.identifier.length === 0) {
    return null;
  }

  const symbols = Helpers.getSymbols(data, dependenciesData);
  if (result.isCallable) {
    const index = symbols.callables.map((clb) => clb.identifier).indexOf(result.identifier);
    if (index < 0) {
      return null;
    }
    const callable = symbols.callables[index];
    return Location.create(callable.file.toString(), Range.create(callable.start, callable.end));
  } else {
    const paramRange = findLocalParameterRange(content, position, result.identifier, data.callables);
    if (paramRange) {
      if (position.line === paramRange.start.line) {
        return null;
      }
      return Location.create(data.uri, paramRange);
    }
    const localRange = findLocalValueRange(content, position, result.identifier);
    if (localRange) {
      if (position.line === localRange.start.line) {
        return null;
      }
      return Location.create(data.uri, localRange);
    }
    const index = symbols.values.map((val) => val.identifier).indexOf(result.identifier);
    if (index < 0) {
      return null;
    }
    const value = symbols.values[index];
    if (position.line === value.range.start.line) {
      return null;
    }
    return Location.create(value.file.toString(), value.range);
  }
}

export function getLocalValueRangeAtPosition(
  content: string,
  position: Position,
  identifier: string
): Range | null {
  if (!identifier) {
    return null;
  }
  const range = findLocalValueRange(content, position, identifier);
  if (!range) {
    return null;
  }
  if (
    position.line === range.start.line &&
    position.character >= range.start.character &&
    position.character <= range.end.character
  ) {
    return range;
  }
  return null;
}

/**
 * If the cursor is inside a "string literal", try to extract an identifier-like token from it.
 * Example: RegisterHamPlayer(Ham_TakeDamage, "Ham_TakeDamage_Pre");
 */
function findIdentifierInsideStringLiteral(content: string, cursorIndex: number): string | null {
  if (cursorIndex < 0 || cursorIndex >= content.length) return null;

  // Find nearest quote to the left
  let left = cursorIndex;
  while (left >= 0 && content[left] !== '"' && content[left] !== '\n') left--;
  if (left < 0 || content[left] !== '"') return null;

  // Find nearest quote to the right
  let right = cursorIndex;
  while (right < content.length && content[right] !== '"' && content[right] !== '\n') right++;
  if (right >= content.length || content[right] !== '"') return null;

  // Cursor must be inside the quotes (not on them)
  if (cursorIndex <= left || cursorIndex >= right) return null;

  const inside = content.slice(left + 1, right);

  // Compute cursor position relative to the inside string
  const rel = cursorIndex - (left + 1);
  if (rel < 0 || rel >= inside.length) return null;

  // Accept AMXX/Pawn identifiers: [A-Za-z_@][A-Za-z0-9_@]*
  const isIdentChar = (ch: string) => /[A-Za-z0-9_@]/.test(ch);

  // If current char isn't identifier-ish, still try to find token around it (common when clicking between chars)
  let start = rel;
  while (start > 0 && isIdentChar(inside[start - 1])) start--;

  let end = rel;
  while (end < inside.length && isIdentChar(inside[end])) end++;

  const token = inside.slice(start, end);
  if (!token) return null;

  // Must not start with a digit
  if (/^\d/.test(token)) return null;

  return token;
}

export function doReferences(
  content: string,
  position: Position,
  uri: string,
  data: Types.DocumentData,
  dependenciesData: WeakMap<DM.FileDependency, Types.DocumentData>
): Location[] {
  const identifier = getIdentifierForReferences(content, position);
  if (!identifier) {
    return [];
  }

  // If cursor is on a callable name, use the canonical callable identifier (helps when cursor is on prototype)
  const symbols = Helpers.getSymbols(data, dependenciesData);
  const callableIdx = symbols.callables.map((c) => c.identifier).indexOf(identifier);
  const finalIdent = callableIdx >= 0 ? symbols.callables[callableIdx].identifier : identifier;

  const results: Location[] = [];

  // 1) identifier occurrences (calls, mentions, etc.)
  results.push(...findAllWordOccurrences(uri, content, finalIdent));

  // 2) string occurrences ("Ham_TakeDamage_Pre")
  results.push(...findAllStringOccurrences(uri, content, finalIdent));

  // Optionally: de-dup (same location can appear twice in edge cases)
  return dedupeLocations(results);
}

export function getIdentifierForReferences(content: string, position: Position): string {
  const cursorIndex = positionToIndex(content, position);

  // Allow references from inside "callback" string literals too
  const stringIdent = findIdentifierInsideStringLiteral(content, cursorIndex);
  const normalIdent = getIdentifierAtOrBehindCursor(content, cursorIndex).identifier;

  return stringIdent || normalIdent || '';
}

export function isCallableDeclarationLine(lineContent: string): boolean {
  const trimmed = lineContent.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const matches = trimmed.match(callableRegex);
  return !!matches && matches.index === 0;
}

function getIdentifierAtOrBehindCursor(content: string, cursorIndex: number): { identifier: string; isCallable: boolean } {
  const at = findIdentifierAtCursor(content, cursorIndex);
  if (at.identifier.length > 0) {
    return at;
  }

  const ident = findIdentifierBehindCursor(content, cursorIndex);
  if (!ident) {
    return { identifier: '', isCallable: false };
  }

  let idx = cursorIndex;
  while (idx < content.length && StringHelpers.isWhitespace(content[idx])) {
    idx++;
  }
  const isCallable = content[idx] === '(';

  return { identifier: ident, isCallable };
}

function findAllWordOccurrences(uri: string, text: string, identifier: string): Location[] {
  const out: Location[] = [];
  const re = new RegExp(`\\b${escapeRegExp(identifier)}\\b`, 'g');
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const start = indexToPosition(text, m.index);
    const end = indexToPosition(text, m.index + m[0].length);
    out.push(Location.create(uri, Range.create(start, end)));
  }

  return out;
}

function findAllStringOccurrences(uri: string, text: string, identifier: string): Location[] {
  const out: Location[] = [];
  const re = new RegExp(`"${escapeRegExp(identifier)}"`, 'g');
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    // highlight only inside quotes
    const start = indexToPosition(text, m.index + 1);
    const end = indexToPosition(text, m.index + 1 + identifier.length);
    out.push(Location.create(uri, Range.create(start, end)));
  }

  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function indexToPosition(text: string, idx: number): Position {
  let line = 0;
  let ch = 0;
  for (let i = 0; i < idx && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      ch = 0;
    } else {
      ch++;
    }
  }
  return { line, character: ch };
}

function dedupeLocations(locs: Location[]): Location[] {
  const seen = new Set<string>();
  const out: Location[] = [];

  for (const l of locs) {
    const key = `${l.uri}:${l.range.start.line}:${l.range.start.character}:${l.range.end.line}:${l.range.end.character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }

  return out;
}

function findLocalParameterRange(
  content: string,
  position: Position,
  identifier: string,
  callables: Types.CallableDescriptor[]
): Range | null {
  const lines = content.split(/\r?\n/);
  if (position.line < 0 || position.line >= lines.length) {
    return null;
  }

  const depthAtLine = computeLineDepths(content);
  const currentDepth = depthAtLine[position.line] ?? 0;
  if (currentDepth <= 0) {
    return null;
  }

  let candidate: Types.CallableDescriptor | null = null;
  for (const clb of callables) {
    if (clb.start.line <= position.line) {
      if (!candidate || clb.start.line > candidate.start.line) {
        candidate = clb;
      }
    }
  }
  if (!candidate) {
    return null;
  }

  const line = lines[candidate.start.line] ?? '';
  const parenIdx = line.indexOf('(');
  if (parenIdx < 0) {
    return null;
  }

  const identRe = new RegExp(`\\b${escapeRegExp(identifier)}\\b`, 'g');
  let match: RegExpExecArray | null;
  while ((match = identRe.exec(line)) !== null) {
    if (match.index > parenIdx) {
      return Range.create(
        { line: candidate.start.line, character: match.index },
        { line: candidate.start.line, character: match.index + identifier.length }
      );
    }
  }

  return null;
}

function findLocalValueRange(content: string, position: Position, identifier: string): Range | null {
  const lines = content.split(/\r?\n/);
  if (position.line < 0 || position.line >= lines.length) {
    return null;
  }

  const depthAtLine = computeLineDepths(content);
  const startDepth = depthAtLine[position.line] ?? 0;
  if (startDepth <= 0) {
    return null;
  }

  const identRe = new RegExp(`\\b${escapeRegExp(identifier)}\\b`);

  for (let targetDepth = startDepth; targetDepth > 0; targetDepth--) {
    let blockStart = position.line;
    while (blockStart >= 0 && (depthAtLine[blockStart] ?? 0) >= targetDepth) {
      blockStart--;
    }
    blockStart = Math.max(0, blockStart + 1);

    let blockEnd = position.line;
    while (blockEnd < lines.length && (depthAtLine[blockEnd] ?? 0) >= targetDepth) {
      blockEnd++;
    }
    blockEnd = Math.min(lines.length - 1, blockEnd - 1);

    let inDecl = false;
    for (let lineIndex = blockStart; lineIndex <= blockEnd; lineIndex++) {
      const depth = depthAtLine[lineIndex] ?? 0;
      if (depth !== targetDepth) {
        inDecl = false;
        continue;
      }

      let line = lines[lineIndex] ?? '';
      const commentIdx = line.indexOf('//');
      if (commentIdx >= 0) {
        line = line.substring(0, commentIdx);
      }
      if (line.trim().length === 0) {
        continue;
      }

      if (!inDecl && /\b(new|const|static|stock)\b/.test(line)) {
        inDecl = true;
      }

      if (inDecl) {
        const range = findDeclaredIdentifierRange(line, identifier);
        if (range) {
          return Range.create(
            { line: lineIndex, character: range.start },
            { line: lineIndex, character: range.end }
          );
        }
      }

      if (inDecl && line.indexOf(';') >= 0) {
        inDecl = false;
      }
    }
  }

  return null;
}

function computeLineDepths(content: string): number[] {
  const depths: number[] = [];
  let depth = 0;
  let line = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  depths[0] = depth;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        line++;
        depths[line] = depth;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === '"' && !isEscapedQuote(content, i)) {
        inString = false;
      }
      if (ch === '\n') {
        line++;
        depths[line] = depth;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === '"' && !isEscapedQuote(content, i)) {
      inString = true;
      continue;
    }

    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
    }

    if (ch === '\n') {
      line++;
      depths[line] = depth;
    }
  }

  return depths;
}

function findDeclaredIdentifierRange(
  line: string,
  identifier: string
): { start: number; end: number } | null {
  const lineNoSpec = stripDeclSpecifiers(line);
  const parts = lineNoSpec.split(',');
  let offset = line.indexOf(lineNoSpec);
  if (offset < 0) {
    offset = 0;
  }

  for (const part of parts) {
    const text = part.trim();
    if (text.length === 0) {
      offset += part.length + 1;
      continue;
    }
    const match = text.match(/^(?:([A-Za-z_@][\w_@]*)\s*:\s*)?([A-Za-z_@][\w_@]*)/);
    if (!match) {
      offset += part.length + 1;
      continue;
    }
    const name = match[2];
    if (name !== identifier) {
      offset += part.length + 1;
      continue;
    }
    const idx = part.indexOf(name);
    const start = idx >= 0 ? offset + idx : offset;
    return { start, end: start + identifier.length };
  }

  return null;
}

function stripDeclSpecifiers(line: string): string {
  return line.replace(/^\s*(?:(?:new|const|static|stock|public)\b\s*)+/, '');
}

function isEscapedQuote(text: string, index: number): boolean {
  if (index <= 0) {
    return false;
  }
  const prev = text[index - 1];
  return prev === '\\' || prev === '^';
}

function normalizeIdentifier(identifier: string): string {
  let i = 0;
  while (i < identifier.length && StringHelpers.isDigit(identifier[i])) {
    i++;
  }
  return i === 0 ? identifier : identifier.substring(i);
}

function isSimpleDefineValue(value: string): boolean {
  const text = value.trim();
  if (text.length === 0) {
    return false;
  }
  if (text === 'true' || text === 'false') {
    return true;
  }
  if (/[0-9]/.test(text) && /^[0-9A-Fa-fxX\s\(\)\|\&\^\~\<\>\+\-\*\/%]+$/.test(text)) {
    return true;
  }
  if (/^0x[0-9a-fA-F]+$/.test(text)) {
    return true;
  }
  if (/^\d+$/.test(text)) {
    return true;
  }
  if (/^"[^"]*"$/.test(text)) {
    return true;
  }
  return false;
}

function extractAssignedValue(part: string): string | null {
  const eqIdx = part.indexOf('=');
  if (eqIdx < 0) {
    return null;
  }
  let value = part.substring(eqIdx + 1).trim();
  const lineComment = value.indexOf('//');
  if (lineComment >= 0) {
    value = value.substring(0, lineComment).trim();
  }
  const blockComment = value.indexOf('/*');
  if (blockComment >= 0) {
    value = value.substring(0, blockComment).trim();
  }
  if (value.endsWith(';')) {
    value = value.substring(0, value.length - 1).trim();
  }
  return value.length > 0 ? value : null;
}

function extractInlineComment(line: string): string | undefined {
  const idx = line.indexOf('//');
  if (idx < 0) {
    return undefined;
  }
  const text = line.substring(idx + 2).trim();
  return text.length > 0 ? text : undefined;
}

function splitTopLevelComma(text: string): { text: string; start: number }[] {
  const parts: { text: string; start: number }[] = [];
  let start = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '"' && !isEscapedQuote(text, i)) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' && !isEscapedQuote(text, i)) {
      inString = true;
      continue;
    }

    if (ch === '(') {
      depthParen++;
      continue;
    }
    if (ch === ')') {
      depthParen = Math.max(0, depthParen - 1);
      continue;
    }
    if (ch === '[') {
      depthBracket++;
      continue;
    }
    if (ch === ']') {
      depthBracket = Math.max(0, depthBracket - 1);
      continue;
    }
    if (ch === '{') {
      depthBrace++;
      continue;
    }
    if (ch === '}') {
      depthBrace = Math.max(0, depthBrace - 1);
      continue;
    }

    if (ch === ',' && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      parts.push({ text: text.substring(start, i), start });
      start = i + 1;
    }
  }

  parts.push({ text: text.substring(start), start });
  return parts;
}

function findDeclaredIdentifierInfo(
  line: string,
  identifier: string
): { start: number; end: number; tag: string; labelAddition: string; part: string } | null {
  const lineNoSpec = stripDeclSpecifiers(line);
  const parts = splitTopLevelComma(lineNoSpec);
  const baseOffset = line.indexOf(lineNoSpec);
  const base = baseOffset >= 0 ? baseOffset : 0;

  for (const part of parts) {
    const text = part.text.trim();
    if (text.length === 0) {
      continue;
    }
    const match = text.match(/^(?:([A-Za-z_@][\w_@]*)\s*:\s*)?([A-Za-z_@][\w_@]*)/);
    if (!match) {
      continue;
    }
    const tag = match[1] ?? '';
    const name = match[2];
    if (name !== identifier) {
      continue;
    }
    const idx = part.text.indexOf(name);
    const offset = base + part.start;
    const start = idx >= 0 ? offset + idx : offset;
    const end = start + identifier.length;
    const labelAddition = extractLabelAddition(part.text, name);
    return { start, end, tag, labelAddition, part: part.text };
  }

  return null;
}

function extractLabelAddition(part: string, identifier: string): string {
  const idx = part.indexOf(identifier);
  if (idx < 0) {
    return '';
  }
  let i = idx + identifier.length;
  let addition = '';
  while (i < part.length && part[i] !== '=' && part[i] !== ',' && part[i] !== ';') {
    addition += part[i];
    i++;
  }
  return addition;
}

function findLocalValueInfo(
  content: string,
  position: Position,
  identifier: string
): LocalValueInfo | null {
  const lines = content.split(/\r?\n/);
  if (position.line < 0 || position.line >= lines.length) {
    return null;
  }

  const depthAtLine = computeLineDepths(content);
  const startDepth = depthAtLine[position.line] ?? 0;
  if (startDepth <= 0) {
    return null;
  }

  for (let targetDepth = startDepth; targetDepth > 0; targetDepth--) {
    let blockStart = position.line;
    while (blockStart >= 0 && (depthAtLine[blockStart] ?? 0) >= targetDepth) {
      blockStart--;
    }
    blockStart = Math.max(0, blockStart + 1);

    let blockEnd = position.line;
    while (blockEnd < lines.length && (depthAtLine[blockEnd] ?? 0) >= targetDepth) {
      blockEnd++;
    }
    blockEnd = Math.min(lines.length - 1, blockEnd - 1);

    let inDecl = false;
    let declIsConst = false;
    for (let lineIndex = blockStart; lineIndex <= blockEnd; lineIndex++) {
      const depth = depthAtLine[lineIndex] ?? 0;
      if (depth !== targetDepth) {
        inDecl = false;
        declIsConst = false;
        continue;
      }

      let line = lines[lineIndex] ?? '';
      const commentIdx = line.indexOf('//');
      if (commentIdx >= 0) {
        line = line.substring(0, commentIdx);
      }
      if (line.trim().length === 0) {
        continue;
      }

      if (!inDecl && /\b(new|const|static|stock)\b/.test(line)) {
        inDecl = true;
        declIsConst = /\bconst\b/.test(line);
      }

      if (inDecl) {
        const info = findDeclaredIdentifierInfo(line, identifier);
        if (info) {
          const assignedValue = declIsConst ? extractAssignedValue(info.part) : null;
          return {
            range: Range.create(
              { line: lineIndex, character: info.start },
              { line: lineIndex, character: info.end }
            ),
            isConst: declIsConst,
            tag: info.tag,
            labelAddition: info.labelAddition,
            assignedValue: assignedValue ?? undefined
          };
        }
      }

      if (inDecl && line.indexOf(';') >= 0) {
        inDecl = false;
        declIsConst = false;
      }
    }
  }

  return null;
}

export function getLocalValueHoverInfo(
  content: string,
  position: Position,
  identifier: string
): { label: string; assignedValue?: string; range: Range } | null {
  const info = findLocalValueInfo(content, position, identifier);
  if (!info) {
    return null;
  }

  const tag = info.tag ? `${info.tag}:` : '';
  const keyword = info.isConst ? 'const ' : 'new ';
  const label = `${keyword}${tag}${identifier}${info.labelAddition}`;

  return {
    label,
    assignedValue: info.assignedValue,
    range: info.range
  };
}
