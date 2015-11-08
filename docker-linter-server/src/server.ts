"use strict";

import {
createConnection, IConnection,
ResponseError, RequestType, IRequestHandler, NotificationType, INotificationHandler,
InitializeResult, InitializeError,
Diagnostic, DiagnosticSeverity, Position, Files,
TextDocuments, ITextDocument, TextDocumentSyncKind,
ErrorMessageTracker
} from "vscode-languageserver";

import { exec, spawn } from "child_process";

interface DockerLinterSettings {
	machine: string;
	container: string;
	command: string;
	regexp: string;
	line: number;
	column: number;
	severity: number;
	message: number;
	code: number;
}

let connection: IConnection = createConnection(process.stdin, process.stdout);
let lib: any = null;
let settings: DockerLinterSettings = null;
let options: any = null;
let documents: TextDocuments = new TextDocuments();

function getDebugString(extra: string): string {
	return [settings.machine, settings.container, settings.command, settings.regexp, extra].join(" | ");
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

function getDiagnostic(match: RegExpExecArray): Diagnostic {
	let line = parseInt(match[settings.line], 10) - 1;

	let start = 0;
	let end = Number.MAX_VALUE;
	if (settings.column) {
		start = end = parseInt(match[settings.column], 10);
	}

	let severity = DiagnosticSeverity.Error;
	if (settings.severity) {
		switch (match[settings.severity]) {
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
		message: match[settings.message]
	};

	if (settings.code) {
		diagnostic.code = match[settings.code];
	}

	return diagnostic;
};

function parseBuffer(buffer: Buffer) {
	let result: Diagnostic[] = [];
	let out = buffer.toString();
	let problemRegex = new RegExp(settings.regexp, "gm");

	let match: RegExpExecArray;
	while (match = problemRegex.exec(out)) {
		result.push(getDiagnostic(match));
	}

	return result;
};

function isInteger(value: number) {
	return isFinite(value) && Math.floor(value) === value;
}

function setMachineEnv(machine: string): Thenable<InitializeResult | ResponseError<InitializeError>> {
	return new Promise<InitializeResult | ResponseError<InitializeError>>((resolve, reject) => {
		exec(`docker-machine env ${machine} --shell bash`, function(error, stdout, stderr) {
			if (error) {
				let errString = stderr.toString();
				reject(new ResponseError<InitializeError>(99, errString, { retry: true }));
			}

			let out = stdout.toString();
			let envRegex = /export (.+)="(.+)"\n/g;

			let match: RegExpExecArray;
			while (match = envRegex.exec(out)) {
				process.env[match[1]] = match[2];
			}

			resolve({ capabilities: { textDocumentSync: documents.syncKind } });
		});
	});
}

documents.listen(connection);
documents.onDidChangeContent((event) => {
	validateSingle(event.document);
});

connection.onInitialize((params): Thenable<InitializeResult | ResponseError<InitializeError>> => {
	return setMachineEnv("default");
});

function validate(document: ITextDocument): void {
	let child = spawn("docker", `exec -i ${settings.container } ${settings.command }`.split(" "));
	child.stdin.write(document.getText());
	child.stdin.end();

	let uri = document.uri;
	let diagnostics: Diagnostic[] = [];
	let debugString = "";

	child.stderr.on("data", (data: Buffer) => {
		debugString += data.toString();
		diagnostics = diagnostics.concat(parseBuffer(data));
	});

	child.stdout.on("data", (data: Buffer) => {
		debugString += data.toString();
		diagnostics = diagnostics.concat(parseBuffer(data));
	});

	child.on("close", (code: string) => {
		if (debugString.match(/^Error response from daemon/)) {
			connection.window.showErrorMessage(getMessage({ message: debugString }, document));
		} else {
			diagnostics.push(getDebugDiagnostic(code + " | " + getDebugString(debugString)));
			connection.sendDiagnostics({ uri, diagnostics });
		}
	});
}

function getMessage(err: any, document: ITextDocument): string {
	let result: string = null;
	if (typeof err.message === "string" || err.message instanceof String) {
		result = <string>err.message;
		result = result.replace(/\r?\n/g, " ");
		if (/^CLI: /.test(result)) {
			result = result.substr(5);
		}
	} else {
		result = `An unknown error occured while validating file: ${Files.uriToFilePath(document.uri) }`;
	}
	return result;
}

function validateSingle(document: ITextDocument): void {
	try {
		validate(document);
	} catch (err) {
		connection.window.showErrorMessage(getMessage(err, document));
	}
}

function validateMany(documents: ITextDocument[]): void {
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

let linters = ["perl", "perlcritic", "flake8"];
connection.onDidChangeConfiguration((params) => {
	let dockerLinterSettings = params.settings["docker-linter"];
	linters.forEach(linter => {
		if (dockerLinterSettings[linter]) {
			settings = dockerLinterSettings[linter];
		};
	});
	validateMany(documents.all());
});

connection.onDidChangeWatchedFiles((params) => {
	validateMany(documents.all());
});

connection.listen();
