'use strict';

import {
  Position,
  ParameterInformation,
  Range,
  Diagnostic
} from 'vscode-languageserver/node';

import * as DM from './dependency-manager';
import { URI } from 'vscode-uri';

export interface InclusionDescriptor {
  // The included filename
  filename: string;

  // This dependency has been included with '#include filename' or '#include "filename"'
  isLocal: boolean;

  // This dependency has been included with '#tryinclude'
  isSilent: boolean;

  // Where in the file is the #include statement
  start: Position;
  end: Position;
}

export interface ResolvedInclusion {
  descriptor: InclusionDescriptor;
  uri: string;
}

export interface CallableDescriptor {
  // Prototype
  label: string;

  // Identifier (without storage specifiers and parameters)
  identifier: string;
  isMacro?: boolean;

  // Where in the file is the callable defined
  // TODO: Make this Location
  file: URI;
  start: Position;
  end: Position;

  // Parameter informations
  parameters: ParameterInformation[];

  documentaton: string;
}

export interface ValueDescriptor {
  // Prototype
  label: string;

  // Identifier (without storage specifiers and parameters)
  identifier: string;

  // Is constant?
  isConst: boolean;
  isEnumMember?: boolean;
  isEnumType?: boolean;
  enumGroup?: string;
  assignedValue?: string;
  inlineComment?: string;

  // Where is it defined
  // TODO: Make this Location
  file: URI;
  range: Range;

  documentaton: string;
}

export class ParserResults {
  public headerInclusions: InclusionDescriptor[];
  public callables: CallableDescriptor[];
  public values: ValueDescriptor[];
  public diagnostics: Diagnostic[];

  public constructor() {
    this.headerInclusions = [];
    this.callables = [];
    this.values = [];
    this.diagnostics = [];
  }
}

export class DocumentData {
  public uri: string;
  public reparseTimer: NodeJS.Timeout | null;
  public resolvedInclusions: ResolvedInclusion[];
  public callables: CallableDescriptor[];
  public values: ValueDescriptor[];
  public dependencies: DM.FileDependency[];

  constructor(uri: string) {
    this.uri = uri;
    this.reparseTimer = null;
    this.resolvedInclusions = [];
    this.callables = [];
    this.values = [];
    this.dependencies = [];
  }
}
