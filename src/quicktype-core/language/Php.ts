import {anyTypeIssueAnnotation, nullTypeIssueAnnotation} from "../Annotation";
import {ConvenienceRenderer, ForbiddenWordsInfo} from "../ConvenienceRenderer";
import {DependencyName, funPrefixNamer, Name, Namer} from "../Naming";
import {RenderContext} from "../Renderer";
import {BooleanOption, StringOption, getOptionValues, Option, OptionValues} from "../RendererOptions";
import {maybeAnnotated, Sourcelike} from "../Source";
import {acronymOption, acronymStyle, AcronymStyleOptions} from "../support/Acronyms";
import {
    allLowerWordStyle,
    allUpperWordStyle,
    combineWords,
    escapeNonPrintableMapper,
    firstUpperWordStyle,
    isAscii,
    isDigit,
    isLetter,
    splitIntoWords,
    standardUnicodeHexEscape,
    utf16ConcatMap,
    utf16LegalizeCharacters
} from "../support/Strings";
import {assert, defined} from "../support/Support";
import {TargetLanguage} from "../TargetLanguage";
import {ArrayType, ClassProperty, ClassType, EnumType, Type, UnionType} from "../Type";
import {directlyReachableSingleNamedType, matchType, nullableFromUnion} from "../TypeUtils";
import {StringTypeMapping, TransformedStringTypeKind, PrimitiveStringTypeKind} from "..";
import * as _ from "lodash";
import {mapSortBy} from "collection-utils";

export const phpOptions = {
    namespace: new StringOption("ns", "Model namespace", "NAMESPACE", "APP"),
    modelInterface: new StringOption("model-interface", "Model interface", "PATH", ""),
    modelHydratorInterface: new StringOption("model-hydrator-interface", "Model hydrator interface", "PATH", ""),
    modelDehydratorInterface: new StringOption("model-dehydrator-interface", "Model dehydrator interface", "PATH", ""),
    withSet: new BooleanOption("with-set", "Create Setter", false),
    acronymStyle: acronymOption(AcronymStyleOptions.Pascal)
};

export class PhpTargetLanguage extends TargetLanguage {
    constructor() {
        super("Php", ["php"], "php");
    }

    protected getOptions(): Option<any>[] {
        return _.values(phpOptions);
    }

    get supportsUnionsWithBothNumberTypes(): boolean {
        return true;
    }

    protected makeRenderer(renderContext: RenderContext, untypedOptionValues: { [name: string]: any }): PhpRenderer {
        const options = getOptionValues(phpOptions, untypedOptionValues);
        return new PhpRenderer(this, renderContext, options);
    }

    get stringTypeMapping(): StringTypeMapping {
        const mapping: Map<TransformedStringTypeKind, PrimitiveStringTypeKind> = new Map();
        mapping.set("date", "date"); // TODO is not implemented yet
        mapping.set("time", "time"); // TODO is not implemented yet
        mapping.set("uuid", "uuid"); // TODO is not implemented yet
        mapping.set("date-time", "date-time");
        return mapping;
    }
}

export const stringEscape = utf16ConcatMap(escapeNonPrintableMapper(isAscii, standardUnicodeHexEscape));

function isStartCharacter(codePoint: number): boolean {
    if (codePoint === 0x5f) return true; // underscore
    return isAscii(codePoint) && isLetter(codePoint);
}

function isPartCharacter(codePoint: number): boolean {
    return isStartCharacter(codePoint) || (isAscii(codePoint) && isDigit(codePoint));
}

const legalizeName = utf16LegalizeCharacters(isPartCharacter);

export function phpNameStyle(
    startWithUpper: boolean,
    upperUnderscore: boolean,
    original: string,
    acronymsStyle: (s: string) => string = allUpperWordStyle
): string {
    const words = splitIntoWords(original);
    return combineWords(
        words,
        legalizeName,
        upperUnderscore ? allUpperWordStyle : startWithUpper ? firstUpperWordStyle : allLowerWordStyle,
        upperUnderscore ? allUpperWordStyle : firstUpperWordStyle,
        upperUnderscore || startWithUpper ? allUpperWordStyle : allLowerWordStyle,
        acronymsStyle,
        upperUnderscore ? "_" : "",
        isStartCharacter
    );
}

export interface FunctionNames {
    readonly getter: Name;
    readonly setter: Name;
    readonly hydrator: Name;
    readonly dehydrator: Name;
}

export class PhpRenderer extends ConvenienceRenderer {
    private static capitaliseFirstLetter(s: string): string {
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    private static isTopLevel(classType: Type): boolean {
        return classType.getParentTypes().size === 0;
    }

    private static getLastItem(path: string): string {
        const parts = path.split("\\");

        if (parts.length > 0) {
            return parts[parts.length-1];
        }

        return path;
    }

    private _currentFilename: string | undefined;
    private readonly _gettersAndSettersForPropertyName = new Map<Name, FunctionNames>();
    private readonly _hydratorClassName: string = "Hydrator";
    protected readonly _converterClassname: string = "Converter";
    protected readonly _converterKeywords: string[] = [];

    constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        protected readonly _options: OptionValues<typeof phpOptions>
    ) {
        super(targetLanguage, renderContext);
    }

    protected sortClassProperties(properties: ReadonlyMap<string, ClassProperty>, _propertyNames: ReadonlyMap<string, Name>): ReadonlyMap<string, ClassProperty> {
        return mapSortBy(properties, (p: ClassProperty,) => {
            return p.type.isNullable ? 1 : 0;
        });
    }

    protected forbiddenForObjectProperties(_c: ClassType, _className: Name): ForbiddenWordsInfo {
        return {names: [], includeGlobalForbidden: true};
    }

    protected makeNamedTypeNamer(): Namer {
        return this.getNameStyling("typeNamingFunction");
    }

    protected namerForObjectProperty(): Namer {
        return this.getNameStyling("propertyNamingFunction");
    }

    protected makeUnionMemberNamer(): Namer {
        return this.getNameStyling("propertyNamingFunction");
    }

    protected makeEnumCaseNamer(): Namer {
        return this.getNameStyling("enumCaseNamingFunction");
    }

    protected unionNeedsName(u: UnionType): boolean {
        return nullableFromUnion(u) === null;
    }

    protected namedTypeToNameForTopLevel(type: Type): Type | undefined {
        return directlyReachableSingleNamedType(type);
    }

    public emitDescriptionBlock(lines: Sourcelike[]): void {
        this.emitCommentLines(lines, " * ", "/**", " */");
    }

    public emitBlock(line: Sourcelike, f: () => void): void {
        this.emitLine(line, " {");
        this.indent(f);
        this.emitLine("}");
    }

    protected makeNamesForPropertyGetterAndSetter(
        _c: ClassType,
        _className: Name,
        _p: ClassProperty,
        _jsonName: string,
        name: Name
    ): FunctionNames {
        const getterName = new DependencyName(
            this.getNameStyling("propertyNamingFunction"),
            name.order,
            lookup => `get_${lookup(name)}`
        );
        const setterName = new DependencyName(
            this.getNameStyling("propertyNamingFunction"),
            name.order,
            lookup => `set_${lookup(name)}`
        );
        const hydratorname = new DependencyName(
            this.getNameStyling("propertyNamingFunction"),
            name.order,
            lookup => `hydrate_${lookup(name)}`
        );
        const dehydratorName = new DependencyName(
            this.getNameStyling("propertyNamingFunction"),
            name.order,
            lookup => `dehydrate_${lookup(name)}`
        );
        return {
            getter: getterName,
            setter: setterName,
            hydrator: hydratorname,
            dehydrator: dehydratorName
        };
    }

    protected makePropertyDependencyNames(
        c: ClassType,
        className: Name,
        p: ClassProperty,
        jsonName: string,
        name: Name
    ): Name[] {
        const getterAndSetterNames = this.makeNamesForPropertyGetterAndSetter(c, className, p, jsonName, name);
        this._gettersAndSettersForPropertyName.set(name, getterAndSetterNames);
        return [
            getterAndSetterNames.getter,
            getterAndSetterNames.setter,
            getterAndSetterNames.hydrator,
            getterAndSetterNames.dehydrator,
        ];
    }

    private getNameStyling(convention: string): Namer {
        const styling: { [key: string]: Namer } = {
            typeNamingFunction: funPrefixNamer("types", n =>
                phpNameStyle(true, false, n, acronymStyle(this._options.acronymStyle))
            ),
            propertyNamingFunction: funPrefixNamer("properties", n =>
                phpNameStyle(false, false, n, acronymStyle(this._options.acronymStyle))
            ),
            enumCaseNamingFunction: funPrefixNamer("enum-cases", n =>
                phpNameStyle(true, true, n, acronymStyle(this._options.acronymStyle))
            )
        };
        return styling[convention];
    }

    protected startFile(basename: Sourcelike): void {
        assert(this._currentFilename === undefined, "Previous file wasn't finished: " + this._currentFilename);
        this._currentFilename = `${this.sourcelikeToString(basename)}.php`;
        this.initializeEmitContextForFilename(this._currentFilename);
    }

    protected endFile(): void {
        this.finishFile(defined(this._currentFilename));
        this._currentFilename = undefined;
    }

    protected emitFileHeader(fileName: Sourcelike, imports: string[]): void {
        this.emitLine("<?php");
        this.emitLine("// This is an autogenerated file:", fileName);
        this.emitLine("declare(strict_types=1);");
        this.ensureBlankLine();
        this.emitLine("namespace", " ", this._options.namespace, ";");
        this.ensureBlankLine();
        for (const imp of imports) {
            this.emitLine("use ", imp, ";");
        }
        this.ensureBlankLine();
    }

    protected phpType(_reference: boolean, t: Type, isOptional: boolean = false, prefix: string = "?", suffix: string = ""): Sourcelike {
        function optionalize(s: Sourcelike) {
            return [isOptional ? prefix : "", s, isOptional ? suffix : ""];
        }

        return matchType<Sourcelike>(
            t,
            _anyType => maybeAnnotated(isOptional, anyTypeIssueAnnotation, "Object"),
            _nullType => maybeAnnotated(isOptional, nullTypeIssueAnnotation, "Object"),
            _boolType => optionalize("bool"),
            _integerType => optionalize("long"),
            _doubleType => optionalize("float"),
            _stringType => optionalize("string"),
            _arrayType => optionalize("array"),
            classType => optionalize(this.nameForNamedType(classType)),
            _mapType => optionalize("stdClass"),
            enumType => optionalize(this.nameForNamedType(enumType)),
            unionType => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null) return this.phpType(true, nullable, true, prefix, suffix);
                return this.nameForNamedType(unionType);
            },
            transformedStringType => {
                if (transformedStringType.kind === "time") {
                    throw Error('transformedStringType.kind === "time"');
                }
                if (transformedStringType.kind === "date") {
                    throw Error('transformedStringType.kind === "date"');
                }
                if (transformedStringType.kind === "date-time") {
                    return "DateTime";
                }
                if (transformedStringType.kind === "uuid") {
                    throw Error('transformedStringType.kind === "uuid"');
                }
                return "string";
            }
        );
    }

    protected phpDocConvertType(className: Name, t: Type): Sourcelike {
        return matchType<Sourcelike>(
            t,
            _anyType => "any",
            _nullType => "null",
            _boolType => "bool",
            _integerType => "int",
            _doubleType => "float",
            _stringType => "string",
            arrayType => [this.phpDocConvertType(className, arrayType.items), "[]"],
            _classType => _classType.getCombinedName(),
            _mapType => "stdClass",
            enumType => this.nameForNamedType(enumType),
            unionType => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null) {
                    return [this.phpDocConvertType(className, nullable), "|null"];
                }
                throw Error("union are not supported");
            },
            transformedStringType => {
                if (transformedStringType.kind === "date-time") {
                    return "DateTime";
                }
                throw Error('transformedStringType.kind === "unknown"');
            }
        );
    }

    protected phpConvertType(className: Name, t: Type): Sourcelike {
        return matchType<Sourcelike>(
            t,
            _anyType => "any",
            _nullType => "null",
            _boolType => "bool",
            _integerType => "int",
            _doubleType => "float",
            _stringType => "string",
            _arrayType => "array",
            _classType => "stdClass",
            _mapType => "stdClass",
            _enumType => "string", // TODO number this.nameForNamedType(enumType),
            unionType => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null) {
                    return ["?", this.phpConvertType(className, nullable)];
                }
                throw Error("union are not supported");
            },
            transformedStringType => {
                if (transformedStringType.kind === "date-time") {
                    return "string";
                }
                throw Error('transformedStringType.kind === "unknown"');
            }
        );
    }

    protected isArray(c: ClassType): boolean {
        let isArray = false;
        c.getParentTypes().forEach(type => {
            if (type instanceof ArrayType) {
                isArray = true;
            }
        });

        return isArray;
    }

    protected emitClassDefinition(c: ClassType, className: Name): void {
        // Skip class generation for array. It is useless
        if (this.isArray(c)) {
            return;
        }

        this.startFile(className);

        const impls: Sourcelike[][] = [];
        const imports = [];
        if (PhpRenderer.isTopLevel(c)) {
            if (this._options.modelInterface !== "") {
                imports.push(this._options.modelInterface);
                impls.push([" implements ", PhpRenderer.getLastItem(this._options.modelInterface)]);
            }
        }

        this.emitFileHeader(className, imports);
        this.emitBlock(["final class ", className, ...impls], () => {
            if (PhpRenderer.isTopLevel(c)) {
                this.ensureBlankLine();
                this.emitLine("public const MESSAGE_NAME = '", className.firstProposedName(this.names), "';");
            }

            this.ensureBlankLine();
            this.forEachClassProperty(c, "none", (name, jsonName, p) => {
                this.emitLine(
                    "private ",
                    this.phpType(false, p.type),
                    " $",
                    name,
                    "; // json:",
                    jsonName,
                    " ",
                    p.type.isNullable ? "Optional" : "Required"
                );
                this.ensureBlankLine();
            });

            this.ensureBlankLine();
            const comments: Sourcelike[][] = [];
            const args: Sourcelike[][] = [];
            let prefix = "";
            this.forEachClassProperty(c, "none", (name, __, p) => {
                args.push([prefix, this.phpType(false, p.type), " $", name]);
                prefix = ", ";
                comments.push([" * @param ", this.phpType(false, p.type, false, "", "|null"), " $", name, "\n"]);
            });
            this.emitBlock(["/**\n", ...comments, " */\n", "public function __construct(", ...args, ")"], () => {
                this.forEachClassProperty(c, "none", name => {
                    this.emitLine("$this->", name, " = $", name, ";");
                });
            });

            if (PhpRenderer.isTopLevel(c)) {
                this.ensureBlankLine();
                this.emitBlock(["public function getMessageName(): string"], () => {
                    this.emitLine("return self::MESSAGE_NAME;");
                });
            }

            this.forEachClassProperty(c, "leading-and-interposing", (name, jsonName, p) => {
                const desc = this.descriptionForClassProperty(c, jsonName);
                const names = defined(this._gettersAndSettersForPropertyName.get(name));

                this.ensureBlankLine();
                this.emitGetMethod(names, p, className, name, desc);
                this.ensureBlankLine();
                this.emitSetMethod(names, p, className, name, desc);
            });
        });

        this.endFile();
    }

    protected emitGetMethod(names: FunctionNames, p: ClassProperty, _className: Name, name: Name, desc?: string[]) {
        this.emitLine("/**");
        if (desc !== undefined) {
            this.emitLine(" * ", desc);
            this.emitLine(" *");
        }
        const rendered = this.phpType(false, p.type);
        this.emitLine(" * @return ", rendered);
        this.emitLine(" */");
        this.emitBlock(["public function ", names.getter, "(): ", rendered], () => {
            this.emitLine("return $this->", name, ";");
        });
    }

    protected emitSetMethod(names: FunctionNames, p: ClassProperty, _className: Name, name: Name, desc?: string[]) {
        if (this._options.withSet) {
            this.emitLine("/**");
            if (desc !== undefined) {
                this.emitLine(" * ", desc);
                this.emitLine(" *");
            }
            this.emitLine(" * @param ", this.phpType(false, p.type, false, "", "|null"));
            this.emitLine(" */");
            this.emitBlock(["public function ", names.setter, "(", this.phpType(false, p.type), " $value)"], () => {
                this.emitLine("$this->", name, " = $value;");
            });
        }
    }

    protected emitUnionDefinition(_u: UnionType, _unionName: Name): void {
        // TODO: implement me
    }

    protected emitEnumSerializationAttributes(_e: EnumType) {
        // TODO: implement me
    }

    protected emitEnumDeserializationAttributes(_e: EnumType) {
        // TODO: implement me
    }

    protected emitEnumDefinition(e: EnumType, enumName: Name): void {
        this.startFile(enumName);

        this.emitFileHeader(enumName, []);
        this.emitDescription(this.descriptionForType(e));

        const enumSerdeType = "string";
        this.emitBlock(["final class ", enumName], () => {
            this.forEachEnumCase(e, "none", (name, _jsonName) => {
                this.emitLine("public static ", enumName, " $", name, ";");
            });

            this.emitBlock("public static function init()", () => {
                this.forEachEnumCase(e, "none", (name, jsonName) => {
                    this.emitLine(enumName, "::$", name, " = new ", enumName, "(\'", jsonName, "\');");
                });
            });

            this.emitLine("private ", enumSerdeType, " $enum;");
            this.emitBlock(["public function __construct(", enumSerdeType, " $enum)"], () => {
                this.emitLine("$this->enum = $enum;");
            });

            this.ensureBlankLine();
            this.emitEnumSerializationAttributes(e);

            this.emitBlock(["/**\n",
                " * @param ", enumName, "\n",
                " * @return ", enumSerdeType, "\n",
                " * @throws Exception\n",
                " */\n",
                "public static function to(", enumName, " $obj): ", enumSerdeType], () => {
                this.emitLine("switch ($obj->enum) {");
                this.indent(() => {
                    this.forEachEnumCase(e, "none", (name, jsonName) => {
                        // Todo String or Number
                        this.emitLine("case ", enumName, "::$", name, "->enum: return '", stringEscape(jsonName), "';");
                    });
                });
                this.emitLine("}");
                this.emitLine("throw new Exception('the give value is not an enum-value.');");
            });
            this.ensureBlankLine();
            this.emitEnumDeserializationAttributes(e);

            this.emitBlock([
                "/**\n",
                " * @param mixed\n",
                " * @return ", enumName, "\n",
                " * @throws Exception\n",
                " */\n",
                "public static function from($obj): ", enumName], () => {
                this.emitLine("switch ($obj) {");
                this.indent(() => {
                    this.forEachEnumCase(e, "none", (name, jsonName) => {
                        // Todo String or Enum
                        this.emitLine("case '", stringEscape(jsonName), "': return ", enumName, "::$", name, ";");
                    });
                });
                this.emitLine("}");
                this.emitLine('throw new Exception("Cannot deserialize ', enumName, '");');
            });
            this.ensureBlankLine();
            this.emitBlock([
                "/**\n",
                " * @return ", enumName, "\n",
                " */\n",
                "public static function sample(): ", enumName], () => {
                const lines: Sourcelike[] = [];
                this.forEachEnumCase(e, "none", (name) => {
                    lines.push([enumName, "::$", name]);
                });
                this.emitLine("return ", lines[0], ";");
            });
        });
        this.emitLine(enumName, "::init();");

        this.endFile();
    }

    protected phpGetHydratorType(_reference: boolean, t: Type): Sourcelike {
        return matchType<Sourcelike>(
            t,
            _anyType => "// anyType",
            _nullType => "// nullType",
            _boolType => "// boolType",
            _integerType => "// integerType",
            _doubleType => "// doubleType",
            _stringType => "// stringType",
            arrayType => {
                return this.phpGetHydratorType(false, arrayType.items);
            },
            classType => [this.nameForNamedType(classType), this._hydratorClassName],
            _mapType => "// stdClass",
            enumType => [this.nameForNamedType(enumType), this._hydratorClassName],
            unionType => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null) {
                    return [this.phpType(true, nullable), this._hydratorClassName];
                }

                return [this.nameForNamedType(unionType), this._hydratorClassName];
            },
            _transformedStringType => "// transformedStringType",
        );
    }

    protected phpHydrateType(jsonName: string, t: Type, lhs: Sourcelike[], args: Sourcelike[]) {
        return matchType<void>(
            t,
            _anyType => this.emitLine(...lhs, ...args, "; /*any*/"),
            _nullType => this.emitLine(...lhs, ...args, "; /*null*/"),
            _boolType => this.emitLine(...lhs, ...args, "; /*bool*/"),
            _integerType => this.emitLine(...lhs, ...args, "; /*int*/"),
            _doubleType => this.emitLine(...lhs, ...args, "; /*float*/"),
            _stringType => this.emitLine(...lhs, ...args, "; /*string*/"),
            _arrayType => {
                this.emitLine(...lhs, "$", jsonName, "; /*array*/");
            },
            classType => {
                this.emitLine(...lhs, "$this->hydrate", PhpRenderer.capitaliseFirstLetter(classType.getCombinedName()), "(", ...args, "); /*class*/");
            },
            _mapType => this.emitLine(...lhs, ...args, "; /*map*/"),
            _enumType => this.emitLine(...lhs, ...args, "; /*enum*/"),
            unionType => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null) {
                    this.phpHydrateType(jsonName, nullable, lhs, args);
                }
            },
            transformedStringType => {
                if (transformedStringType.kind === "date-time") {
                    this.emitLine(...lhs, ...args, "->format(DateTimeInterface::ISO8601);");
                    return;
                }
                throw Error('transformedStringType.kind === "unknown"');
            }
        );
    }

    protected phpDehydrateType(jsonName: string, t: Type, lhs: Sourcelike[], args: Sourcelike[]) {
        return matchType<void>(
            t,
            _anyType => this.emitLine(...lhs, ...args, ", /*any*/"),
            _nullType => this.emitLine(...lhs, ...args, ", /*null*/"),
            _boolType => this.emitLine(...lhs, ...args, ", /*bool*/"),
            _integerType => this.emitLine(...lhs, ...args, ", /*int*/"),
            _doubleType => this.emitLine(...lhs, ...args, ", /*float*/"),
            _stringType => this.emitLine(...lhs, ...args, ", /*string*/"),
            _arrayType => {
                this.emitLine(...lhs, "$", jsonName, ", /*array*/");
            },
            classType => {
                this.emitLine(...lhs, "$this->dehydrate", PhpRenderer.capitaliseFirstLetter(classType.getCombinedName()), "(", ...args, "), /*class*/");
            },
            _mapType => this.emitLine(...lhs, ...args, ", /*map*/"),
            _enumType => this.emitLine(...lhs, ...args, ", /*enum*/"),
            unionType => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null) {
                    this.phpDehydrateType(jsonName, nullable, lhs, args);
                }
            },
            transformedStringType => {
                if (transformedStringType.kind === "date-time") {
                    this.emitLine(...lhs, ...args, "->format(DateTimeInterface::ISO8601),");
                    return;
                }
                throw Error('transformedStringType.kind === "unknown"');
            }
        );
    }

    protected getFirstChildren(t: Type): Type | null {
        const children = t.getChildren();
        if (children.size === 0) {
            return null;
        }

        const [item] = children;
        return item;
    }

    protected getClassTypeFromType(type: Type): ClassType | null {
        if (type instanceof ClassType) {
            return type;
        }

        if (type instanceof UnionType) {
            const nullable = nullableFromUnion(type);
            if (nullable !== null && nullable instanceof ClassType) {
                return nullable;
            }
        }

        if (type instanceof ArrayType) {
            const child = this.getFirstChildren(type);
            if (child !== null) {
                const childChild = this.getFirstChildren(child);
                if (childChild !== null) {
                    if (childChild instanceof ClassType) return childChild;
                    if (childChild instanceof UnionType) {
                        const nullable = nullableFromUnion(childChild);
                        if (nullable !== null && nullable instanceof ClassType) {
                            return nullable;
                        }
                    }
                }
            }
        }

        return null;
    }

    protected emitArrayHydrateDefinition(classType: ClassType) {
        this.forEachClassProperty(classType, "none", (name, _jsonName, p) => {
            let type = p.type;
            if (p.type instanceof UnionType) {
                const nullable = nullableFromUnion(p.type);
                if (nullable !== null) {
                    type = nullable;
                }
            }

            if (!(type instanceof ArrayType)) {
                return;
            }

            const names = defined(this._gettersAndSettersForPropertyName.get(name));

            this.ensureBlankLine();
            this.emitLine("$", name, " = [];");
            this.emitBlock(["foreach ($message->", names.getter, "() as $value)"], () => {
                const child = this.getFirstChildren(type);
                if (child == null) {
                    return;
                }

                if (child.isPrimitive()) {
                    this.emitLine("$", name, "[] = $value;");
                } else {
                    const secondChild = this.getFirstChildren(child);
                    if (secondChild == null) {
                        return;
                    }

                    this.emitLine("$", name, "[] = $this->hydrate", PhpRenderer.capitaliseFirstLetter(secondChild.getCombinedName()), "($value);");
                }
            });
        });
    }

    protected emitArrayDehydrateDefinition(classType: ClassType) {
        this.forEachClassProperty(classType, "none", (name, _jsonName, p) => {
            let type = p.type;
            if (p.type instanceof UnionType) {
                const nullable = nullableFromUnion(p.type);
                if (nullable !== null) {
                    type = nullable;
                }
            }

            if (!(type instanceof ArrayType)) {
                return;
            }

            this.ensureBlankLine();
            this.emitLine("$", name, " = [];");
            this.emitBlock(["foreach ($data['", name, "'] as $value)"], () => {
                const child = this.getFirstChildren(type);
                if (child == null) {
                    return;
                }

                if (child.isPrimitive()) {
                    this.emitLine("$", name, "[] = $value;");
                } else {
                    const secondChild = this.getFirstChildren(child);
                    if (secondChild == null) {
                        return;
                    }

                    this.emitLine("$", name, "[] = $this->dehydrate", PhpRenderer.capitaliseFirstLetter(secondChild.getCombinedName()), "($value);");
                }
            });
        });
    }

    protected emitTopHydrateDefinition(className: Name, classType: ClassType) {
        let modelInterface = "";
        if (this._options.modelInterface !== "") {
            modelInterface = PhpRenderer.getLastItem(this._options.modelInterface) + " ";
        }

        this.emitBlock(["public function hydrate(", modelInterface, "$message): stdClass"], () => {
            this.emitBlock(["if (!($message instanceof ", className, "))"], () => {
                this.indent(() => {
                    this.emitLine("throw new RuntimeException($message->getMessageName(), self::class);");
                });
            });

            this.emitArrayHydrateDefinition(classType);

            this.ensureBlankLine();
            this.emitLine(["$res = new stdClass();"]);
            this.forEachClassProperty(classType, "none", (name, jsonName, classProperty) => {
                const names = defined(this._gettersAndSettersForPropertyName.get(name));
                this.phpHydrateType(jsonName, classProperty.type, ["$res->", name, " = "], ["$message->", names.getter, "()"]);
            });

            this.ensureBlankLine();
            this.emitLine(["return $res;"]);
        });

        this.forEachClassProperty(classType, "none", (name, _jsonName, classProperty) => {
            this.emitNestedHydrateDefinition(name, classProperty.type);
        });
    }

    protected emitNestedHydrateDefinition(_className: Name, type: Type) {
        const classType = this.getClassTypeFromType(type);

        if (classType == null) return;

        this.emitArrayHydrateDefinition(classType);

        const phpType = this.phpType(false, classType);
        const hydrateFuncName = "hydrate" + PhpRenderer.capitaliseFirstLetter(classType.getCombinedName());

        this.ensureBlankLine();
        this.emitBlock(["public function ", hydrateFuncName, "(", phpType, " $obj): stdClass"], () => {
            this.emitLine(["$res = new stdClass();"]);
            this.forEachClassProperty(classType, "none", (name, jsonName, p) => {
                const names = defined(this._gettersAndSettersForPropertyName.get(name));
                this.phpHydrateType(jsonName, p.type, ["$res->", name, " = "], ["$obj->", names.getter, "()"]);
            });
            this.ensureBlankLine();
            this.emitLine(["return $res;"]);
        });

        this.forEachClassProperty(classType, "none", (name, _jsonName, classProperty) => {
            this.ensureBlankLine();
            this.emitNestedHydrateDefinition(name, classProperty.type);
        });
    }

    protected emitTopDehydrateDefinition(className: Name, classType: ClassType) {
        let modelInterface = "";
        if (this._options.modelInterface !== "") {
            modelInterface = ": " + PhpRenderer.getLastItem(this._options.modelInterface);
        }

        this.emitBlock(["public function dehydrate(array $data)", modelInterface], () => {
            this.forEachClassProperty(classType, "none", (name, _jsonName, property) => {
                if (!property.type.isNullable) {
                    this.ensureBlankLine();
                    this.emitBlock(["if (!isset($data['", name, "']))"], () => {
                        this.emitLine("throw new RuntimeException(\"Property '", name, "' not set\");");
                    });
                }
            });

            this.emitArrayDehydrateDefinition(classType);

            this.ensureBlankLine();
            this.emitLine(["return new ", className, "("]);
            this.indent(() => {
                this.forEachClassProperty(classType, "none", (_name, jsonName, property) => {
                    let opt = "";
                    if (property.type.isNullable) {
                        opt = " ?? null";
                    }

                    this.phpDehydrateType(jsonName, property.type, [], ["$data['", jsonName, "']", opt]);
                });
            });
            this.emitLine(");");
        });

        this.forEachClassProperty(classType, "none", (name, _jsonName, classProperty) => {
            this.emitNestedDehydrateDefinition(name, classProperty.type);
        });
    }

    protected emitNestedDehydrateDefinition(_className: Name, type: Type) {
        const classType = this.getClassTypeFromType(type);

        if (classType == null) return;

        const phpType = this.phpType(false, classType);
        const dehydrateFuncName = "dehydrate" + PhpRenderer.capitaliseFirstLetter(classType.getCombinedName());

        this.ensureBlankLine();
        this.emitBlock(["public function ", dehydrateFuncName, "(array $data): ", phpType], () => {
            this.emitLine(["return new ", phpType, "("]);
            this.indent(() => {
                this.forEachClassProperty(classType, "none", (_name, jsonName, p) => {
                    this.phpDehydrateType(jsonName, p.type, [], ["$data['", jsonName, "']"]);
                });
            });
            this.emitLine(");");
        });

        this.forEachClassProperty(classType, "none", (name, _jsonName, classProperty) => {
            this.ensureBlankLine();
            this.emitNestedDehydrateDefinition(name, classProperty.type);
        });
    }

    protected emitTopClassHydratorDehydrator(classType: ClassType, className: Name): void {
        const impl: Sourcelike[][] = [];
        const imports = [];

        if (this._options.modelInterface !== "") {
            imports.push(this._options.modelInterface);
        }

        if (this._options.modelHydratorInterface !== "") {
            impl.push([PhpRenderer.getLastItem(this._options.modelHydratorInterface)]);
            imports.push(this._options.modelHydratorInterface);
        }

        if (this._options.modelDehydratorInterface !== "") {
            if (impl.length > 0) {
                impl.push([", "]);
            }

            impl.push([PhpRenderer.getLastItem(this._options.modelDehydratorInterface)]);
            imports.push(this._options.modelDehydratorInterface);
        }

        if (impl.length > 0) {
            impl.unshift([" implements "]);
        }

        this.emitFileHeader(
            [className, this._hydratorClassName],
            [
                ...imports,
                "RuntimeException",
                "stdClass",
            ]);

        this.emitBlock(["final class ", className, this._hydratorClassName, ...impl], () => {
            this.ensureBlankLine();
            this.emitTopHydrateDefinition(className, classType);
            this.ensureBlankLine();
            this.emitTopDehydrateDefinition(className, classType);
        });
    }

    protected emitClassHydratorDehydrator(classType: ClassType, className: Name): void {
        if (!PhpRenderer.isTopLevel(classType)) {
            return;
        }

        this.startFile([className, this._hydratorClassName]);
        this.emitTopClassHydratorDehydrator(classType, className);
        this.endFile();
    }

    /**
     * Start generation
     *
     *  ./../script/quicktype -s schema -l php -o ./ --ns "TSP\MessageBus\Example\Consumer\Gen" ./schema/* #ALL SCHEMAS
     *  ./../script/quicktype -s schema -l php -o ./SVC.MessageName.V2.php --ns "TSP\MessageBus\Example\Consumer\Gen" ./schema/SVC.MessageName.v2.json #ONE
     * @param _givenFilename
     * @protected
     */
    protected emitSourceStructure(_givenFilename: string): void {
        this.forEachNamedType(
            "leading-and-interposing",
            (c: ClassType, n: Name) => this.emitClassDefinition(c, n),
            (e, n) => this.emitEnumDefinition(e, n),
            (u, n) => this.emitUnionDefinition(u, n)
        );

        this.forEachNamedType(
            "leading-and-interposing",
            (c: ClassType, n: Name) => this.emitClassHydratorDehydrator(c, n),
            (_e, _n) => {
                // TODO: not implemented
            },
            (_u, _n) => {
                // TODO: not implemented
            }
        );
    }
}