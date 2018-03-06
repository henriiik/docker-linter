"use strict";

import { Diagnostic, DiagnosticSeverity, ErrorMessageTracker, Files, InitializeError, InitializeParams, InitializeResult, NotificationType, Position, RequestHandler, RequestType, ResponseError, TextDocument, TextDocumentSyncKind, TextDocuments, createConnection, ProposedFeatures } from "vscode-languageserver";

import { exec, spawn } from "child_process";

interface DockerLinterSettings {
	machine: string;
	container: string;
	command: string;
	regexp: string;
	line: number;
	column: number;
	severity: number | string;
	message: number;
	code: number;
}

let connection = createConnection(ProposedFeatures.all);

let linterSettings: DockerLinterSettings = null;
let linterName = "";
let debug = false;

let documents: TextDocuments = new TextDocuments();
let ready = false;

function log(message) {
	connection.console.log(`${linterName}: ${message}`);
}

function getDebugString(extra: string): string {
	return [linterSettings.machine, linterSettings.container, linterSettings.command, linterSettings.regexp, extra].join(" | ");
};

function getDebugDiagnostic(message: string): Diagnostic {
	return {
		range: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: Number.MAX_VALUE },
		},
		severity: DiagnosticSeverity.Information,
		message
	};
}

function getDiagnostic(match: RegExpMatchArray): Diagnostic {
	let line = parseInt(match[linterSettings.line], 10) - 1;

	let start = 0;
	let end = Number.MAX_VALUE;
	if (linterSettings.column) {
		start = end = parseInt(match[linterSettings.column], 10) - 1;
	}

	let severity: DiagnosticSeverity = DiagnosticSeverity.Error;
	if (linterSettings.severity) {
		let tmp = linterSettings.severity;
		if (typeof tmp === "number") {
			tmp = match[Number(tmp)];
		}
		switch (tmp) {
			case "warning":
				severity = DiagnosticSeverity.Warning;
				break;
			case "info":
				severity = DiagnosticSeverity.Information;
				break;
		}
	}

	let diagnostic: Diagnostic = {
		range: {
			start: { line, character: start },
			end: { line, character: end }
		},
		severity,
		message: match[linterSettings.message]
	};

	if (linterSettings.code) {
		diagnostic.code = match[linterSettings.code];
	}

	return diagnostic;
};

function parseBuffer(buffer: Buffer) {
	let result: Diagnostic[] = [];
	let lines = buffer.toString().split("\n");
	let problemRegex = new RegExp(linterSettings.regexp, "m");

	lines.forEach(line => {
		let match = line.match(problemRegex);
		if (match) {
			result.push(getDiagnostic(match));
		}
	});

	return result;
};

function isInteger(value: number) {
	return isFinite(value) && Math.floor(value) === value;
}

function checkDockerVersion(): Thenable<InitializeResult> {
	return new Promise<InitializeResult>((resolve, reject) => {
		exec(`docker -v`, function (error, stdout, stderr) {
			if (error) {
				let errString = `Could not find docker: '${stderr.toString()}'`;
				reject(new ResponseError<InitializeError>(99, errString, { retry: true }));
			}

			resolve({ capabilities: { textDocumentSync: documents.syncKind } });
		});
	});
}

function setMachineEnv(machine: string): Thenable<string> {
	return new Promise<string>((resolve, reject) => {
		if (machine.length === 0) {
			resolve(machine);
		} else {
			resolve("Yeah")
			// exec(`docker-machine env ${machine} --shell bash`, function (error, stdout, stderr) {
			// 	if (error) {
			// 		let errString = stderr.toString();
			// 		connection.window.showErrorMessage(`Could not get docker-machine environment: '${errString}'`);
			// 		reject(machine);
			// 	}

			// 	let out = stdout.toString();
			// 	let envRegex = /export (.+)="(.+)"\n/g;

			// 	let match: RegExpExecArray;
			// 	while (match = envRegex.exec(out)) {
			// 		process.env[match[1]] = match[2];
			// 	}

			// 	resolve(machine);
			// });
		}
	});
}

documents.listen(connection);
documents.onDidChangeContent((event) => {
	validateSingle(event.document);
});

connection.onInitialize((params): Thenable<InitializeResult> | Thenable<ResponseError<InitializeError>> => {
	return checkDockerVersion();
});

let isValidating: { [index: string]: boolean } = {};
let needsValidating: { [index: string]: TextDocument } = {};

function validate(document: TextDocument): void {
	let uri = document.uri;
	if (debug) {
		log(`Validation requested for: ${uri}`);
	}

	if (!ready || isValidating[uri]) {
		needsValidating[uri] = document;
		return;
	};

	isValidating[uri] = true;

	let cmd = "docker"
	let args = `exec -i ${linterSettings.container} ${linterSettings.command}`;
	if (debug) {
		log(`Running command: '${cmd} ${args}'`);
	}
	let child = spawn(cmd, args.split(" "));


	let input = document.getText();
	if (debug) {
		log(`Writing buffer:`);
		connection.console.log(input);
	}
	
	let written = child.stdin.write(input);
	child.stdin.end();
	if (debug) {
		log(`Write return value: '${written}'`);
	}
	
	let diagnostics: Diagnostic[] = [];
	let debugString = "";
	
	child.stderr.on("data", (data: Buffer) => {
		let tmp = data.toString();
		if (debug) {
			log(`Data on stderr:`);
			connection.console.log(tmp);
		}			
		debugString += tmp;
		diagnostics = diagnostics.concat(parseBuffer(data));
	});

	child.stdout.on("data", (data: Buffer) => {
		let tmp = data.toString();
		if (debug) {
			log(`Data on stdout:`);
			connection.console.log(tmp);
		}			
		debugString += tmp;
		diagnostics = diagnostics.concat(parseBuffer(data));
	});

	child.on("close", (code: string) => {
		if (debug) {
			log(`Command exited with code: ${code}`)
			connection.console.log(debugString);
		}

		if (debugString.match(/^Error response from daemon/)) {
			connection.window.showErrorMessage(`Is your container running? Error: ${debugString}`);
		} else if (debugString.match(/^An error occurred trying to connect/)) {
			connection.window.showErrorMessage(`Is your machine correctly configured? Error: ${debugString}`);
		} else {
			connection.sendDiagnostics({ uri, diagnostics });
		}

		isValidating[uri] = false;
		let revalidateDocument = needsValidating[uri];

		if (revalidateDocument) {
			if (debug) {
				log(`Re-validating: ${uri}`);
			}
			delete needsValidating[uri];
			validate(revalidateDocument);
		} else {
			if (debug) {
				log(`Validation finished for: ${uri}`);
			}
		}
	});
}

function getMessage(err: any, document: TextDocument): string {
	let result: string = null;
	if (typeof err.message === "string" || err.message instanceof String) {
		result = err.message;
		result = result.replace(/\r?\n/g, " ");
		if (/^CLI: /.test(result)) {
			result = result.substr(5);
		}
	} else {
		result = `An unknown error occured while validating file: ${Files.uriToFilePath(document.uri)}`;
	}
	return result;
}

function validateSingle(document: TextDocument): void {
	try {
		validate(document);
	} catch (err) {
		connection.window.showErrorMessage(getMessage(err, document));
	}
}

function validateMany(documents: TextDocument[]): void {
	let tracker = new ErrorMessageTracker();
	documents.forEach(document => {
		try {
			validate(document);
		} catch (err) {
			tracker.add(getMessage(err, document));
		}
	});
	tracker.sendErrors(connection);
}

let linters = ["perl", "perlcritic", "flake8", "rubocop", "php"];
connection.onDidChangeConfiguration((params) => {
	let settings = params.settings["docker-linter"];

	debug = settings.debug === true ? true : false;

	linters.forEach(linter => {
		if (settings[linter]) {
			linterSettings = settings[linter];
			linterName = linter;
		};
	});

	if (debug) {
		log(`Settings updated.`);
	}

	setMachineEnv(linterSettings.machine)
		.then(response => {
			ready = true;
			validateMany(documents.all());
		});
});

connection.onDidChangeWatchedFiles((params) => {
	validateMany(documents.all());
});

connection.listen();
