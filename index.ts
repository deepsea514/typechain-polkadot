import * as FsAPI from 'fs';
import * as FsExtraAPI from 'fs-extra';
import * as PathAPI from 'path';
import YARGS from 'yargs';
import type ABI from './src/abi_interface';
import * as ARGUMENTS_TEMPLATES from './src/generators/arguments';
import * as OK_RETURNS_TEMPLATES from './src/generators/return-values';
import * as QUERY_TEMPLATES from './src/generators/query';
import * as BUILD_EXTRINSIC_TEMPLATES from './src/generators/build-extrinsic';
import * as TX_SIGN_AND_SEND_TEMPLATES from './src/generators/tx-sign-and-send';
import * as MIXED_METHODS_TEMPLATES from './src/generators/mixed-methods';
import * as CONTRACT_TEMPLATES from './src/generators/contract';
import {typeDecoder} from "./src";
import {Type, Method, Import} from "./src/types";

const _argv = YARGS
	.option('input', {
		alias: ['in'],
		demandOption: "Please, specify, where to take ABIs",
		description: 'Input relative path',
		type: 'string',
	})
	.option('output', {
		demandOption: "Please, specify, where to put generated files",
		alias: ['out'],
		description: 'Output relative path',
		type: 'string',
	})
	.help().alias('help', 'h')
	.argv;

const argv = _argv as Awaited<typeof _argv>;

const cwdPath = process.cwd();
const absPathToABIs = PathAPI.resolve( cwdPath, `./${argv.input}` );
const absPathToOutput = PathAPI.resolve( cwdPath, `./${argv.output}` );


// Prep of output directory

__assureDirExists(absPathToOutput, '');
__assureDirExists(absPathToOutput, '_sdk');
FsExtraAPI.copySync(
	PathAPI.resolve(__dirname, 'src/generators/raw/_sdk'),
	PathAPI.resolve(absPathToOutput, '_sdk')
);
__assureDirExists(absPathToOutput, "arguments");
__assureDirExists(absPathToOutput, "return-values");
__assureDirExists(absPathToOutput, "query");
__assureDirExists(absPathToOutput, "build-extrinsic");
__assureDirExists(absPathToOutput, "tx-sign-and-send");
__assureDirExists(absPathToOutput, "mixed-methods");
__assureDirExists(absPathToOutput, "contracts");
__assureDirExists(absPathToOutput, "types");

// Parsing inputs & generating outputs

const fullFileNames = FsAPI.readdirSync(absPathToABIs);

for(const fullFileName of fullFileNames) {
	if( !fullFileName.endsWith('.json') ) continue;
	const fileName = fullFileName.slice(0, -5);
	const _abiStr = FsAPI.readFileSync( PathAPI.resolve(absPathToABIs, fullFileName), 'utf8' );
	const _json = JSON.parse(_abiStr);
	if(!_json.V3) {
		console.error(`File "${fullFileName}" is not a V3 ABI`);
		continue;
	}
	const abi : ABI = _json;

	let methods: Method[] = [];
	let types: Type[] = [];
	let _argsTypes: Type[] = [];
	let imports: Import[] = [];

	const { decoder, result } = typeDecoder(_abiStr);

	// [ types ]

	const _str = result.enums.concat(result.composites).map(e => e.body).join('\n\n');

	__writeFileSync(absPathToOutput, `types/${fileName}.ts`, _str);

	// [ out/arguments ]

	const __allArgs = abi.V3.spec.messages.map(m => m.args).flat();
	const __uniqueArgs : typeof __allArgs = [];
	for(const __arg of __allArgs)
		if(!__uniqueArgs.find(__a => __a.type.type === __arg.type.type))
			__uniqueArgs.push(__arg);

	_argsTypes = __uniqueArgs.map(a => ({
		id: a.type.type,
		tsStr: decoder(a.type.type),
	}));

	methods = abi.V3.spec.messages.map(__m => ({
		name: __m.label,
		args: __m.args.map(__a => ({
			name: __a.label,
			type: _argsTypes.find(_a => _a.id == __a.type.type)!,
		})),
	}));

	let argumentsImports = new Set<string>();

	for (const _argType of _argsTypes) {
		const typeStr = _argType.tsStr;
		if (result.composites.find(e => e.name == typeStr) || result.enums.find(e => e.name == typeStr))
		{
			argumentsImports.add(_argType.tsStr);
		}
	}

	imports = [];
	imports.push({
		values: Array.from(argumentsImports),
		path: `../types/${fileName}`,
	});

	methods = abi.V3.spec.messages.map(__m => {
		return ({
			name: __m.label,
			args: __m.args.map(__a => ({
				name: __a.label,
				type: _argsTypes.find(_a => _a.id == __a.type.type)!,
			})),
		});
	});

	__writeFileSync(absPathToOutput, `arguments/${fileName}.ts`, ARGUMENTS_TEMPLATES.FILE(
		_argsTypes,
		methods,
		imports
	));

	// [ out/return-values ]

	let returnValuesImports = new Set<string>();

	const _returnTypesIDs = Array.from( new Set(
		abi.V3.spec.messages.filter(m => m.returnType).map(m => m.returnType!.type)
	) );

	imports = [];
	types = [];
	for(const id of _returnTypesIDs) {
		const typeName = decoder(id);

		if (result.enums.find(e => e.name === typeName) || result.composites.find(e => e.name == typeName)) {
			returnValuesImports.add(typeName);
		}

		types.push({
			id: id,
			tsStr: typeName,
		});
	}
	imports.push({
		values: Array.from(returnValuesImports),
		path: `../types/${fileName}`,
	});

	__writeFileSync(absPathToOutput, `return-values/${fileName}.ts`, OK_RETURNS_TEMPLATES.FILE(types, imports));

	// [ out/query ]
	imports = [];
	methods = [];
	for(const __message of abi.V3.spec.messages) {
		methods.push({
			name: __message.label,
			args: __message.args.map(__a => ({
				name: __a.label,
				type: _argsTypes.find(_a => _a.id == __a.type.type)!,
			})),
			returnType: __message.returnType && {
				tsStr: decoder(__message.returnType!.type),
				id: __message.returnType!.type
			},
			payable: __message.payable,
			mutating: __message.mutates,
			methodType: 'query',
		});
	}

	__writeFileSync(absPathToOutput, `query/${fileName}.ts`, QUERY_TEMPLATES.FILE(fileName, methods, imports));

	// [ out/build-extrinsic ]

	imports = [];
	methods = [];
	for(const __message of abi.V3.spec.messages) {
		methods.push({
			name: __message.label,
			args: __message.args.map(__a => ({
				name: __a.label,
				type: _argsTypes.find(_a => _a.id == __a.type.type)!,
			})),
			payable: __message.payable,
			methodType: 'extrinsic',
		});
	}

	__writeFileSync(absPathToOutput, `build-extrinsic/${fileName}.ts`, BUILD_EXTRINSIC_TEMPLATES.FILE(fileName, methods, imports));

	// [ out/tx-sign-and-send ]

	imports = [];
	methods = [];
	for(const __message of abi.V3.spec.messages) {
		methods.push({
			name: __message.label,
			args: __message.args.map(__a => ({
				name: __a.label,
				type: _argsTypes.find(_a => _a.id == __a.type.type)!,
			})),
			payable: __message.payable,
			methodType: 'tx',
		});
	}

	__writeFileSync(absPathToOutput, `tx-sign-and-send/${fileName}.ts`, TX_SIGN_AND_SEND_TEMPLATES.FILE(fileName, methods, imports));

	// [ out/mixed-methods ]

	imports = [];
	methods = [];
	for(const __message of abi.V3.spec.messages) {
		if(__message.mutates) {
			methods.push({
				name: __message.label,
				args: __message.args.map(__a => ({
					name: __a.label,
					type: _argsTypes.find(_a => _a.id == __a.type.type)!,
				})),
				payable: __message.payable,
				methodType: 'tx',
			});
		}
		else {
			methods.push({
				name: __message.label,
				args: __message.args.map(__a => ({
					name: __a.label,
					type: _argsTypes.find(_a => _a.id == __a.type.type)!,
				})),
				returnType: __message.returnType && {
					tsStr: decoder(__message.returnType!.type),
					id: __message.returnType!.type
				},
				payable: __message.payable,
				mutating: __message.mutates,
				methodType: 'query',
			});
		}
	}

	__writeFileSync(absPathToOutput, `mixed-methods/${fileName}.ts`, MIXED_METHODS_TEMPLATES.FILE(fileName, methods, imports));

	// [ out/contracts ]

	imports = [];
	const relPathFromOutL1toABIs = PathAPI.relative(
		PathAPI.resolve(absPathToOutput, "contracts"),
		absPathToABIs
	);

	__writeFileSync(absPathToOutput, `contracts/${fileName}.ts`, CONTRACT_TEMPLATES.FILE(fileName, relPathFromOutL1toABIs, imports));
}

function __assureDirExists(absPathToBase : string, relPathToDir : string) {
	const absPath = PathAPI.resolve( absPathToBase, `./${relPathToDir}` );
	if( !FsAPI.existsSync(absPath) ) FsAPI.mkdirSync(absPath);
}

function __writeFileSync(absPathToBase : string, relFilePath : string, contents : string) {
	FsAPI.writeFileSync(
		PathAPI.resolve( absPathToBase, `./${relFilePath}` ),
		contents
	);
}