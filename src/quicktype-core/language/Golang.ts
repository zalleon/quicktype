import {TypeKind, Type, ClassType, EnumType, UnionType, ClassProperty} from "../Type";
import {matchType, nullableFromUnion, removeNullFromUnion} from "../TypeUtils";
import {Name, DependencyName, Namer, funPrefixNamer} from "../Naming";
import {
    legalizeCharacters,
    isLetterOrUnderscore,
    isLetterOrUnderscoreOrDigit,
    stringEscape,
    splitIntoWords,
    combineWords,
    firstUpperWordStyle,
    allUpperWordStyle,
    camelCase,
} from "../support/Strings";
import {assert, defined} from "../support/Support";
import {StringOption, BooleanOption, Option, OptionValues, getOptionValues} from "../RendererOptions";
import {Sourcelike, maybeAnnotated, modifySource} from "../Source";
import {anyTypeIssueAnnotation, nullTypeIssueAnnotation} from "../Annotation";
import {TargetLanguage} from "../TargetLanguage";
import {ConvenienceRenderer} from "../ConvenienceRenderer";
import {RenderContext} from "../Renderer";

export const goOptions = {
    justTypes: new BooleanOption("just-types", "Plain types only", false),
    justTypesAndPackage: new BooleanOption("just-types-and-package", "Plain types with package only", false),
    packageName: new StringOption("package", "Generated package name", "NAME", "main"),
    sdkPackage: new StringOption("sdk-package", "Generated sdk package name", "PATH", ""),
    multiFileOutput: new BooleanOption("multi-file-output", "Renders each top-level object in its own Go file", false),
};

export class GoTargetLanguage extends TargetLanguage {
    constructor() {
        super("Go", ["go", "golang"], "go");
    }

    protected getOptions(): Option<any>[] {
        return [
            goOptions.justTypes,
            goOptions.packageName,
            goOptions.sdkPackage,
            goOptions.multiFileOutput,
            goOptions.justTypesAndPackage
        ];
    }

    get supportsUnionsWithBothNumberTypes(): boolean {
        return true;
    }

    get supportsOptionalClassProperties(): boolean {
        return true;
    }

    protected makeRenderer(renderContext: RenderContext, untypedOptionValues: { [name: string]: any }): GoRenderer {
        return new GoRenderer(this, renderContext, getOptionValues(goOptions, untypedOptionValues));
    }

    protected get defaultIndentation(): string {
        return "\t";
    }
}

const namingFunction = funPrefixNamer("namer", goNameStyle);

const legalizeName = legalizeCharacters(isLetterOrUnderscoreOrDigit);

function goNameStyle(original: string): string {
    const words = splitIntoWords(original);
    return combineWords(
        words,
        legalizeName,
        firstUpperWordStyle,
        firstUpperWordStyle,
        allUpperWordStyle,
        allUpperWordStyle,
        "",
        isLetterOrUnderscore
    );
}

const primitiveValueTypeKinds: TypeKind[] = ["integer", "double", "bool", "string"];
const compoundTypeKinds: TypeKind[] = ["array", "class", "map", "enum"];

function isValueType(t: Type): boolean {
    const kind = t.kind;
    return primitiveValueTypeKinds.indexOf(kind) >= 0 || kind === "class" || kind === "enum";
}

function singleDescriptionComment(description: string[] | undefined): string {
    if (description === undefined) return "";
    return "// " + description.join("; ");
}

function canOmitEmpty(cp: ClassProperty): boolean {
    if (!cp.isOptional) return false;
    const t = cp.type;
    return ["union", "null", "any"].indexOf(t.kind) < 0;
}

export class GoRenderer extends ConvenienceRenderer {
    private readonly _topLevelUnmarshalNames = new Map<Name, Name>();
    private _currentFilename: string | undefined;

    constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _options: OptionValues<typeof goOptions>
    ) {
        super(targetLanguage, renderContext);
    }

    protected makeNamedTypeNamer(): Namer {
        return namingFunction;
    }

    protected namerForObjectProperty(): Namer {
        return namingFunction;
    }

    protected makeUnionMemberNamer(): Namer {
        return namingFunction;
    }

    protected makeEnumCaseNamer(): Namer {
        return namingFunction;
    }

    protected get enumCasesInGlobalNamespace(): boolean {
        return true;
    }

    protected makeTopLevelDependencyNames(_: Type, topLevelName: Name): DependencyName[] {
        const unmarshalName = new DependencyName(
            namingFunction,
            topLevelName.order,
            (lookup) => `unmarshal_${lookup(topLevelName)}`
        );
        this._topLevelUnmarshalNames.set(topLevelName, unmarshalName);
        return [unmarshalName];
    }

    /// startFile takes a file name, lowercases it, appends ".go" to it, and sets it as the current filename.
    protected startFile(basename: Sourcelike): void {
        if (this._options.multiFileOutput === false) {
            return;
        }

        assert(this._currentFilename === undefined, "Previous file wasn't finished: " + this._currentFilename);
        // FIXME: The filenames should actually be Sourcelikes, too
        this._currentFilename = `${this.sourcelikeToString(basename)}.go`.toLowerCase();
        this.initializeEmitContextForFilename(this._currentFilename);
    }

    /// endFile pushes the current file name onto the collection of finished files and then resets the current file name. These finished files are used in index.ts to write the output.
    protected endFile(): void {
        if (this._options.multiFileOutput === false) {
            return;
        }

        this.finishFile(defined(this._currentFilename));
        this._currentFilename = undefined;
    }

    private emitBlock(line: Sourcelike, f: () => void): void {
        this.emitLine(line, " {");
        this.indent(f);
        this.emitLine("}");
    }

    private emitFunc(decl: Sourcelike, f: () => void): void {
        this.emitBlock(["func ", decl], f);
    }

    private emitStruct(name: Name, table: Sourcelike[][]): void {
        this.emitBlock(["type ", name, " struct"], () => this.emitTable(table));
    }

    private nullableGoType(t: Type, withIssues: boolean): Sourcelike {
        const goType = this.goType(t, withIssues);
        if (isValueType(t)) {
            return ["*", goType];
        } else {
            return goType;
        }
    }

    private propertyGoType(cp: ClassProperty): Sourcelike {
        const t = cp.type;
        if (t instanceof UnionType && nullableFromUnion(t) === null) {
            return ["*", this.goType(t, true)];
        }
        if (cp.isOptional) {
            return this.nullableGoType(t, true);
        }
        return this.goType(t, true);
    }

    private goType(t: Type, withIssues: boolean = false): Sourcelike {
        return matchType<Sourcelike>(
            t,
            (_anyType) => maybeAnnotated(withIssues, anyTypeIssueAnnotation, "interface{}"),
            (_nullType) => maybeAnnotated(withIssues, nullTypeIssueAnnotation, "interface{}"),
            (_boolType) => "bool",
            (_integerType) => "int64",
            (_doubleType) => "float64",
            (_stringType) => "string",
            (arrayType) => ["[]", this.goType(arrayType.items, withIssues)],
            (classType) => this.nameForNamedType(classType),
            (mapType) => {
                let valueSource: Sourcelike;
                const v = mapType.values;
                if (v instanceof UnionType && nullableFromUnion(v) === null) {
                    valueSource = ["*", this.nameForNamedType(v)];
                } else {
                    valueSource = this.goType(v, withIssues);
                }
                return ["map[string]", valueSource];
            },
            (enumType) => this.nameForNamedType(enumType),
            (unionType) => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null) return this.nullableGoType(nullable, withIssues);
                return this.nameForNamedType(unionType);
            }
        );
    }

    private emitTopLevel(t: Type, name: Name): void {
        this.startFile(name);

        if (
            this._options.multiFileOutput &&
            this._options.justTypes === false &&
            this._options.justTypesAndPackage === false &&
            this.leadingComments === undefined
        ) {
            this.emitLineOnce(
                "// This file was generated from JSON Schema using quicktype, do not modify it directly."
            );
            this.emitLineOnce("// To parse and unparse this JSON data, add this code to your project and do:");
            this.emitLineOnce("//");
            const ref = modifySource(camelCase, name);
            this.emitLineOnce("//    ", ref, ", err := ", defined(this._topLevelUnmarshalNames.get(name)), "(bytes)");
            this.emitLineOnce("//    bytes, err = ", ref, ".Marshal()");
        }

        this.emitPackageDefinitons(true);

        if (this.namedTypeToNameForTopLevel(t) === undefined) {
            this.emitLine("type ", name, " ", this.goType(t));
        }

        if (this._options.justTypes || this._options.justTypesAndPackage) return;

        this.emitLine(["const ", name, "MessageName = \"", name.firstProposedName(this.names), "\""]);

        this.ensureBlankLine();
        this.emitFunc(["(m *", name, ") GetMessageName() string"], () => {
            this.emitLine(["return ", name, "MessageName"]);
        });

        this.ensureBlankLine();
        this.emitFunc(["(m *", name, ") Decode(data []byte) error"], () => {
            this.emitBlock(["if err := json.Unmarshal(data, m); err != nil"], () => {
                this.emitLine("return fmt.Errorf(\"json unmarshal for message %s failed, %w\", ", name, "MessageName, err)");
            });
            this.ensureBlankLine();
            this.emitLine("return nil");
        });

        this.ensureBlankLine();
        this.emitFunc(["(m *", name, ") Encode() ([]byte, error)"], () => {
            this.emitLine("payload, err := json.Marshal(m)");
            this.emitBlock(["if err != nil"], () => {
                this.emitLine("return nil, fmt.Errorf(\"json marshal %s message error. %w\", m.GetMessageName(), err)");
            });
            this.ensureBlankLine();
            this.emitLine("return payload, nil");
        });
        this.endFile();
    }

    private emitClass(c: ClassType, className: Name): void {
        this.startFile(className);
        this.emitPackageDefinitons(false);
        let columns: Sourcelike[][] = [];
        this.forEachClassProperty(c, "none", (name, jsonName, p) => {
            const goType = this.propertyGoType(p);
            const comment = singleDescriptionComment(this.descriptionForClassProperty(c, jsonName));
            const omitEmpty = canOmitEmpty(p) ? ",omitempty" : [];
            columns.push([[name, " "], [goType, " "], ['`json:"', stringEscape(jsonName), omitEmpty, '"`'], comment]);
        });
        this.emitDescription(this.descriptionForType(c));
        this.emitStruct(className, columns);
        this.endFile();
    }

    private emitEnum(e: EnumType, enumName: Name): void {
        this.startFile(enumName);
        this.emitPackageDefinitons(false);
        this.emitDescription(this.descriptionForType(e));
        this.emitLine("type ", enumName, " string");
        this.emitLine("const (");
        this.indent(() =>
            this.forEachEnumCase(e, "none", (name, jsonName) => {
                this.emitLine(name, " ", enumName, ' = "', stringEscape(jsonName), '"');
            })
        );
        this.emitLine(")");
        this.endFile();
    }

    private emitUnion(u: UnionType, unionName: Name): void {
        this.startFile(unionName);
        this.emitPackageDefinitons(false);
        const [hasNull, nonNulls] = removeNullFromUnion(u);
        const isNullableArg = hasNull !== null ? "true" : "false";

        const ifMember: <T, U>(
            kind: TypeKind,
            ifNotMember: U,
            f: (t: Type, fieldName: Name, goType: Sourcelike) => T
        ) => T | U = (kind, ifNotMember, f) => {
            const maybeType = u.findMember(kind);
            if (maybeType === undefined) return ifNotMember;
            return f(maybeType, this.nameForUnionMember(u, maybeType), this.goType(maybeType));
        };

        const maybeAssignNil = (kind: TypeKind): void => {
            ifMember(kind, undefined, (_1, fieldName, _2) => {
                this.emitLine("x.", fieldName, " = nil");
            });
        };
        const makeArgs = (
            primitiveArg: (fieldName: Sourcelike) => Sourcelike,
            compoundArg: (isClass: boolean, fieldName: Sourcelike) => Sourcelike
        ): Sourcelike => {
            const args: Sourcelike = [];
            for (const kind of primitiveValueTypeKinds) {
                args.push(
                    ifMember(kind, "nil", (_1, fieldName, _2) => primitiveArg(fieldName)),
                    ", "
                );
            }
            for (const kind of compoundTypeKinds) {
                args.push(
                    ifMember(kind, "false, nil", (t, fieldName, _) => compoundArg(t.kind === "class", fieldName)),
                    ", "
                );
            }
            args.push(isNullableArg);
            return args;
        };

        let columns: Sourcelike[][] = [];
        this.forEachUnionMember(u, nonNulls, "none", null, (fieldName, t) => {
            const goType = this.nullableGoType(t, true);
            columns.push([[fieldName, " "], goType]);
        });
        this.emitDescription(this.descriptionForType(u));
        this.emitStruct(unionName, columns);

        if (this._options.justTypes || this._options.justTypesAndPackage) return;

        this.ensureBlankLine();
        this.emitFunc(["(x *", unionName, ") UnmarshalJSON(data []byte) error"], () => {
            for (const kind of compoundTypeKinds) {
                maybeAssignNil(kind);
            }
            ifMember("class", undefined, (_1, _2, goType) => {
                this.emitLine("var c ", goType);
            });
            const args = makeArgs(
                (fn) => ["&x.", fn],
                (isClass, fn) => {
                    if (isClass) {
                        return "true, &c";
                    } else {
                        return ["true, &x.", fn];
                    }
                }
            );
            this.emitLine("object, err := unmarshalUnion(data, ", args, ")");
            this.emitBlock("if err != nil", () => {
                this.emitLine("return err");
            });
            this.emitBlock("if object", () => {
                ifMember("class", undefined, (_1, fieldName, _2) => {
                    this.emitLine("x.", fieldName, " = &c");
                });
            });
            this.emitLine("return nil");
        });
        this.ensureBlankLine();
        this.emitFunc(["(x *", unionName, ") MarshalJSON() ([]byte, error)"], () => {
            const args = makeArgs(
                (fn) => ["x.", fn],
                (_, fn) => ["x.", fn, " != nil, x.", fn]
            );
            this.emitLine("return marshalUnion(", args, ")");
        });
        this.endFile();
    }

    private emitSingleFileHeaderComments(): void {
        this.emitLineOnce("// This file was generated from JSON Schema using quicktype, do not modify it directly.");
        this.emitLineOnce("// To parse and unparse this JSON data, add this code to your project and do:");
        // this.forEachTopLevel("none", (_: Type, name: Name) => {
        //     this.emitLine("//");
        //     const ref = modifySource(camelCase, name);
        //     this.emitLine("//    ", ref, ", err := ", defined(this._topLevelUnmarshalNames.get(name)), "(bytes)");
        //     this.emitLine("//    bytes, err = ", ref, ".Marshal()");
        // });
    }

    private emitPackageDefinitons(includeJSONEncodingImport: boolean): void {
        if (!this._options.justTypes || this._options.justTypesAndPackage) {
            this.ensureBlankLine();
            const packageDeclaration = "package " + this._options.packageName;
            this.emitLineOnce(packageDeclaration);
            this.ensureBlankLine();
        }

        if (!this._options.justTypes && !this._options.justTypesAndPackage) {
            this.ensureBlankLine();
            if (this.haveNamedUnions && this._options.multiFileOutput === false) {
                this.emitLineOnce('import "bytes"');
                this.emitLineOnce('import "errors"');
            }

            if (includeJSONEncodingImport) {
                this.emitLineOnce('import "encoding/json"');
                this.emitLineOnce('import "fmt"');
            }
            this.ensureBlankLine();
        }
    }

    private emitHelperFunctions(): void {
        if (this.haveNamedUnions) {
            this.startFile("JSONSchemaSupport");
            this.emitPackageDefinitons(true);
            if (this._options.multiFileOutput) {
                this.emitLineOnce('import "bytes"');
                this.emitLineOnce('import "errors"');
            }
            this.ensureBlankLine();
            this
                .emitMultiline(`func unmarshalUnion(data []byte, pi **int64, pf **float64, pb **bool, ps **string, haveArray bool, pa interface{}, haveObject bool, pc interface{}, haveMap bool, pm interface{}, haveEnum bool, pe interface{}, nullable bool) (bool, error) {
    if pi != nil {
        *pi = nil
    }
    if pf != nil {
        *pf = nil
    }
    if pb != nil {
        *pb = nil
    }
    if ps != nil {
        *ps = nil
    }

    dec := json.NewDecoder(bytes.NewReader(data))
    dec.UseNumber()
    tok, err := dec.Token()
    if err != nil {
        return false, err
    }

    switch v := tok.(type) {
    case json.Number:
        if pi != nil {
            i, err := v.Int64()
            if err == nil {
                *pi = &i
                return false, nil
            }
        }
        if pf != nil {
            f, err := v.Float64()
            if err == nil {
                *pf = &f
                return false, nil
            }
            return false, errors.New("Unparsable number")
        }
        return false, errors.New("Union does not contain number")
    case float64:
        return false, errors.New("Decoder should not return float64")
    case bool:
        if pb != nil {
            *pb = &v
            return false, nil
        }
        return false, errors.New("Union does not contain bool")
    case string:
        if haveEnum {
            return false, json.Unmarshal(data, pe)
        }
        if ps != nil {
            *ps = &v
            return false, nil
        }
        return false, errors.New("Union does not contain string")
    case nil:
        if nullable {
            return false, nil
        }
        return false, errors.New("Union does not contain null")
    case json.Delim:
        if v == '{' {
            if haveObject {
                return true, json.Unmarshal(data, pc)
            }
            if haveMap {
                return false, json.Unmarshal(data, pm)
            }
            return false, errors.New("Union does not contain object")
        }
        if v == '[' {
            if haveArray {
                return false, json.Unmarshal(data, pa)
            }
            return false, errors.New("Union does not contain array")
        }
        return false, errors.New("Cannot handle delimiter")
    }
    return false, errors.New("Cannot unmarshal union")

}

func marshalUnion(pi *int64, pf *float64, pb *bool, ps *string, haveArray bool, pa interface{}, haveObject bool, pc interface{}, haveMap bool, pm interface{}, haveEnum bool, pe interface{}, nullable bool) ([]byte, error) {
    if pi != nil {
        return json.Marshal(*pi)
    }
    if pf != nil {
        return json.Marshal(*pf)
    }
    if pb != nil {
        return json.Marshal(*pb)
    }
    if ps != nil {
        return json.Marshal(*ps)
    }
    if haveArray {
        return json.Marshal(pa)
    }
    if haveObject {
        return json.Marshal(pc)
    }
    if haveMap {
        return json.Marshal(pm)
    }
    if haveEnum {
        return json.Marshal(pe)
    }
    if nullable {
        return json.Marshal(nil)
    }
    return nil, errors.New("Union must not be null")
}`);
            this.endFile();
        }
    }

    private emitEncoder(): void {
        this.startFile("encoder");

        this.emitLine(["package ", this._options.packageName]);
        this.ensureBlankLine();
        this.emitLine([`import "fmt"`]);
        this.ensureBlankLine();
        this.emitLine(`var ErrNotSupportedObject = fmt.Errorf("object is not supportable, must be self encodable")`);
        this.ensureBlankLine();
        this.emitLine("type Encoder struct{}");
        this.ensureBlankLine();
        this.emitFunc(["NewEncoder() *Encoder"], () => {
            this.emitLine("return &Encoder{}");
        });
        this.ensureBlankLine();
        this.emitFunc(["(e *Encoder) Encode(v interface{}) ([]byte, error)"], () => {
            this.emitLine(["switch msg := v.(type) {"]);
            this.forEachTopLevel(
                "none",
                (_t, name) => {
                    this.emitLine(["case ", name, ":"]);
                    this.indent(() => {
                        this.emitLine("res, err := msg.Encode()");
                        this.emitBlock(["if err != nil"], () => {
                            this.emitLine([`return nil, fmt.Errorf("encoding of bus message %s, %w", msg.GetMessageName(), err)`]);
                        });
                        this.ensureBlankLine();
                        this.emitLine("return res, nil");
                    });
                },
            );
            this.emitLine("default:");
            this.indent(() => {
                this.emitLine("return nil, ErrNotSupportedObject");
            });
            this.emitLine("}");
        });

        this.endFile();
    }

    private emitDecoder(): void {
        this.startFile("decoder");

        this.emitLine(["package ", this._options.packageName]);
        this.ensureBlankLine();
        this.emitLine([`import "fmt"`]);
        if (this._options.sdkPackage !== "") {
            this.emitLine([`import "`, this._options.sdkPackage, `"`]);
        }
        this.ensureBlankLine();
        this.emitLine(`var ErrUnexpectedMessage = fmt.Errorf("unexpected message")`);
        this.ensureBlankLine();
        this.emitLine("type Decoder struct{}");
        this.ensureBlankLine();
        this.emitFunc(["NewDecoder() *Decoder"], () => {
            this.emitLine("return &Decoder{}");
        });
        this.ensureBlankLine();
        this.emitFunc(["(e *Decoder) Decode(messageName string, payload []byte) (sdk.MessageInterface, error)"], () => {
            this.emitLine(["switch messageName {"]);
            this.forEachTopLevel(
                "none",
                (_t, name) => {
                    this.emitLine(["case ", name, "MessageName:"]);
                    this.indent(() => {
                        this.emitLine(["m := ", name, "{}"]);
                        this.emitBlock(["if err := m.Decode(payload); err != nil"], () => {
                            this.emitLine([`return nil, fmt.Errorf("decode message %s failed. %w", messageName, err)`]);
                        });
                        this.ensureBlankLine();
                        this.emitLine("return m, nil");
                    });
                },
            );
            this.emitLine("default:");
            this.indent(() => {
                this.emitLine(`return nil, fmt.Errorf("%w, name %s", ErrUnexpectedMessage, messageName)`);
            });
            this.emitLine("}");
        });

        this.endFile();
    }

    protected emitSourceStructure(): void {
        if (
            this._options.multiFileOutput === false &&
            this._options.justTypes === false &&
            this._options.justTypesAndPackage === false &&
            this.leadingComments === undefined
        ) {
            this.emitSingleFileHeaderComments();
        }

        this.forEachTopLevel(
            "leading-and-interposing",
            (t, name) => this.emitTopLevel(t, name),
            (t) =>
                !(this._options.justTypes || this._options.justTypesAndPackage) ||
                this.namedTypeToNameForTopLevel(t) === undefined
        );
        this.forEachObject("leading-and-interposing", (c: ClassType, className: Name) => this.emitClass(c, className));
        this.forEachEnum("leading-and-interposing", (u: EnumType, enumName: Name) => this.emitEnum(u, enumName));
        this.forEachUnion("leading-and-interposing", (u: UnionType, unionName: Name) => this.emitUnion(u, unionName));

        this.emitEncoder();
        this.emitDecoder();

        if (this._options.justTypes || this._options.justTypesAndPackage) {
            return;
        }

        this.emitHelperFunctions();
    }
}
