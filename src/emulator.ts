﻿import _context = require('./context');
import _cpu = require('./core/cpu');
import _gpu = require('./core/gpu');
import _controller = require('./core/controller');
import _display = require('./core/display');
import _audio = require('./core/audio');
import _interrupt = require('./core/interrupt');
import _memory = require('./core/memory');
import _format = require('./format/format');
import _format_cso = require('./format/cso');
import _format_iso = require('./format/iso');
import _format_zip = require('./format/zip');
import _pbp = require('./format/pbp');
import _psf = require('./format/psf');
import _vfs = require('./hle/vfs');
import _elf_psp = require('./hle/elf_psp');
import _elf_crypted_prx = require('./hle/elf_crypted_prx');

import _manager_memory = require('./hle/manager/memory');
import _manager_file = require('./hle/manager/file');
import _manager_thread = require('./hle/manager/thread');
import _manager_module = require('./hle/manager/module');
import _pspmodules = require('./hle/pspmodules');

import FileMode = _vfs.FileMode;
import FileOpenFlags = _vfs.FileOpenFlags;
import Vfs = _vfs.Vfs;
import VfsEntry = _vfs.VfsEntry;
import VfsStat = _vfs.VfsStat;
import MountableVfs = _vfs.MountableVfs;
import UriVfs = _vfs.UriVfs;
import IsoVfs = _vfs.IsoVfs;
import ZipVfs = _vfs.ZipVfs;
import MemoryVfs = _vfs.MemoryVfs;

import PspElfLoader = _elf_psp.PspElfLoader;

import MemoryManager = _manager_memory.MemoryManager;
import Memory = _memory.Memory;
import EmulatorContext = _context.EmulatorContext;
import InterruptManager = _interrupt.InterruptManager;
import FileManager = _manager_file.FileManager;
import PspAudio = _audio.PspAudio;
import PspDisplay = _display.PspDisplay;
import PspGpu = _gpu.PspGpu;
import PspController = _controller.PspController;
import InstructionCache = _cpu.InstructionCache;
import SyscallManager = _cpu.SyscallManager;
import ThreadManager = _manager_thread.ThreadManager;
import ModuleManager = _manager_module.ModuleManager;

export class Emulator {
	public context: EmulatorContext;
	private memory: Memory;
	private memoryManager: MemoryManager;
	private interruptManager: InterruptManager;
	private fileManager: FileManager;
	private audio: PspAudio;
	private canvas: HTMLCanvasElement;
	private webgl_canvas: HTMLCanvasElement;
	private display: PspDisplay;
	private gpu: PspGpu;
	private controller: PspController;
	private instructionCache: InstructionCache;
	private syscallManager: SyscallManager;
	private threadManager: ThreadManager;
	private moduleManager: ModuleManager;
	private ms0Vfs: MountableVfs;

	constructor(memory?: Memory) {
		if (!memory) memory = Memory.instance;
		this.memory = memory;
	}

	stopAsync() {
		if (!this.display) return Promise.resolve();

		return Promise.all([
			this.display.stopAsync(),
			this.controller.stopAsync(),
			this.gpu.stopAsync(),
			this.audio.stopAsync(),
			this.threadManager.stopAsync(),
		]);
	}

	startAsync() {
		return this.stopAsync().then(() => {
			this.memory.reset();
			this.context = new EmulatorContext();
			this.memoryManager = new MemoryManager();
			this.audio = new PspAudio();
			this.canvas = <HTMLCanvasElement>(document.getElementById('canvas'));
			this.webgl_canvas = <HTMLCanvasElement>(document.getElementById('webgl_canvas'));
			this.display = new PspDisplay(this.memory, this.canvas, this.webgl_canvas);
			this.gpu = new PspGpu(this.memory, this.display, this.webgl_canvas);
			this.controller = new PspController();
			this.instructionCache = new InstructionCache(this.memory);
			this.syscallManager = new SyscallManager(this.context);
			this.fileManager = new FileManager();
			this.threadManager = new ThreadManager(this.memory, this.memoryManager, this.display, this.syscallManager, this.instructionCache);
			this.moduleManager = new ModuleManager(this.context);
			this.interruptManager = new InterruptManager();

			this.fileManager.mount('ms0', this.ms0Vfs = new MountableVfs());
			this.fileManager.mount('host0', new MemoryVfs());

			this.ms0Vfs.mountVfs('/', new MemoryVfs());

			_pspmodules.registerModulesAndSyscalls(this.syscallManager, this.moduleManager);

			this.context.init(this.interruptManager, this.display, this.controller, this.gpu, this.memoryManager, this.threadManager, this.audio, this.memory, this.instructionCache, this.fileManager);

			return Promise.all([
				this.display.startAsync(),
				this.controller.startAsync(),
				this.gpu.startAsync(),
				this.audio.startAsync(),
				this.threadManager.startAsync(),
			]);
		});
	}

	private gameTitle: string = '';

	private processParamsPsf(psf: _psf.Psf) {
		this.gameTitle = psf.entriesByName['TITLE'];
		console.log(psf.entriesByName);
	}

	private changeFavicon(src) {
		var link = document.createElement('link'),
			oldLink = document.getElementById('dynamic-favicon');
		link.id = 'dynamic-favicon';
		link.rel = 'shortcut icon';
		link.href = src;
		if (oldLink) {
			document.head.removeChild(oldLink);
		}
		document.head.appendChild(link);
	}

	private loadIcon0(data: Stream) {
		//console.log('loadIcon0---------');
		//console.log(data);
		if (data.length == 0) {
			this.changeFavicon('icon.png');
		} else {
			this.changeFavicon(data.toImageUrl());
		}
		//var item = document.head.querySelector('link[rel="shortcut icon"]');
		//item['href'] = ;
	}

	private loadPic1(data: Stream) {
		//console.log('loadPic1---------');
		//console.log(data);
		document.body.style.backgroundRepeat = 'no-repeat';
		document.body.style.backgroundSize = 'cover';
		document.body.style.backgroundPosition = 'center center';
		document.body.style.backgroundImage = 'url("' + data.toImageUrl() + '")';
	}

	private _loadAndExecuteAsync(asyncStream: AsyncStream, pathToFile: string) {
		return _format.detectFormatAsync(asyncStream).then((fileFormat):any => {
			console.info(sprintf('File:: size: %d, format: "%s", name: "%s"', asyncStream.size, fileFormat, asyncStream.name));
			switch (fileFormat) {
				case 'ciso':
					return _format_cso.Cso.fromStreamAsync(asyncStream).then(asyncStream2 => this._loadAndExecuteAsync(asyncStream2, pathToFile));
				case 'pbp':
					return asyncStream.readChunkAsync(0, asyncStream.size).then(executableArrayBuffer => {
						var pbp = _pbp.Pbp.fromStream(Stream.fromArrayBuffer(executableArrayBuffer));
						var psf = _psf.Psf.fromStream(pbp.get(_pbp.Names.ParamSfo));
						this.processParamsPsf(psf);
						this.loadIcon0(pbp.get(_pbp.Names.Icon0Png));
						this.loadPic1(pbp.get(_pbp.Names.Pic1Png));

						return this._loadAndExecuteAsync(new MemoryAsyncStream(pbp.get(_pbp.Names.PspData).toArrayBuffer()), pathToFile);
					});
				case 'psp':
					return asyncStream.readChunkAsync(0, asyncStream.size).then(executableArrayBuffer => {
						_elf_crypted_prx.decrypt(new Uint8Array(executableArrayBuffer));
						throw (new Error("Not supported encrypted elf files yet!"));
					});
				case 'zip':
					return _format_zip.Zip.fromStreamAsync(asyncStream).then(zip => {
						var zipFs = new ZipVfs(zip);
						var mountableVfs = (<MountableVfs>this.fileManager.getDevice('ms0').vfs);
						mountableVfs.mountVfs('/PSP/GAME/virtual', zipFs);

						var availableElf = ['/EBOOT.ELF', '/BOOT.ELF', '/EBOOT.PBP'].first(item => zip.has(item));

						console.log('elf: ' + availableElf);

						return zipFs.openAsync(availableElf, FileOpenFlags.Read, parseInt('0777', 8)).then((node) => {
							return node.readAllAsync().then((data) => {
								return this._loadAndExecuteAsync(MemoryAsyncStream.fromArrayBuffer(data), 'ms0:/PSP/GAME/virtual/EBOOT.ELF');
							});
						});
					});
				case 'iso':
					return _format_iso.Iso.fromStreamAsync(asyncStream).then(iso => {
						var isoFs = new IsoVfs(iso);
						this.fileManager.mount('umd0', isoFs);
						this.fileManager.mount('disc0', isoFs);

						return isoFs.readAllAsync('PSP_GAME/PARAM.SFO').then(paramSfoData => {
							var psf = _psf.Psf.fromStream(Stream.fromArrayBuffer(paramSfoData));
							this.processParamsPsf(psf);

							var icon0Promise = isoFs.readAllAsync('PSP_GAME/ICON0.PNG').then(data => { this.loadIcon0(Stream.fromArrayBuffer(data)); }).catch(() => { });
							var pic1Promise = isoFs.readAllAsync('PSP_GAME/PIC1.PNG').then(data => { this.loadPic1(Stream.fromArrayBuffer(data)); }).catch(() => { });

							return isoFs.readAllAsync('PSP_GAME/SYSDIR/BOOT.BIN').then(bootBinData => {
								return this._loadAndExecuteAsync(MemoryAsyncStream.fromArrayBuffer(bootBinData), 'umd0:/PSP_GAME/SYSDIR/BOOT.BIN');
							});
						});

					});
				case 'elf':
					return asyncStream.readChunkAsync(0, asyncStream.size).then(executableArrayBuffer => {
						if (this.gameTitle) {
							document.title = this.gameTitle + ' - jspspemu';
						} else {
							document.title = 'jspspemu';
						}

						var mountableVfs = (<MountableVfs>this.fileManager.getDevice('ms0').vfs);
						mountableVfs.mountFileData('/PSP/GAME/virtual/EBOOT.ELF', executableArrayBuffer);

						var elfStream = Stream.fromArrayBuffer(executableArrayBuffer);

						var arguments = [pathToFile];
						var argumentsPartition = this.memoryManager.userPartition.allocateLow(0x4000);
						var argument = arguments.map(argument => argument + String.fromCharCode(0)).join('');
						this.memory.getPointerStream(argumentsPartition.low).writeString(argument);

						//console.log(new Uint8Array(executableArrayBuffer));
						var pspElf = new PspElfLoader(this.memory, this.memoryManager, this.moduleManager, this.syscallManager);
						pspElf.load(elfStream);
						this.context.symbolLookup = pspElf;
						var moduleInfo = pspElf.moduleInfo;

						//window['saveAs'](new Blob([this.memory.getPointerDataView(0x08000000, 0x2000000)]), 'after_allocate_and_write_dump.bin');

						// "ms0:/PSP/GAME/virtual/EBOOT.PBP"
						var thread = this.threadManager.create('main', moduleInfo.pc, 10);
						thread.state.GP = moduleInfo.gp;
						thread.state.gpr[4] = argument.length;
						thread.state.gpr[5] = argumentsPartition.low;
						thread.start();
					});

				default:
					throw (new Error(sprintf("Unhandled format '%s'", fileFormat)));
			}
		});
	}

	loadExecuteAndWaitAsync(asyncStream: AsyncStream, url: string) {
		this.gameTitle = '';
		return this.loadAndExecuteAsync(asyncStream, url).then(() => {
			//console.error('WAITING!');
			return this.threadManager.waitExitGameAsync().then(() => {
				//console.error('STOPPING!');
				return this.stopAsync();
			});
		}).catch(e => {
			console.error(e);
			throw(e);
		});
	}
	

	loadAndExecuteAsync(asyncStream: AsyncStream, url: string) {
		this.gameTitle = '';
		this.loadIcon0(Stream.fromArray([]));
		this.loadPic1(Stream.fromArray([]));
		return this.startAsync().then(() => {
			var parentUrl = url.replace(/\/[^//]+$/, '');
			console.info('parentUrl: ' + parentUrl);
			this.ms0Vfs.mountVfs('/PSP/GAME/virtual', new UriVfs(parentUrl));
			return this._loadAndExecuteAsync(asyncStream, "ms0:/PSP/GAME/virtual/EBOOT.PBP");
		}).catch(e => {
			console.error(e);
			throw (e);
		});
	}

	downloadAndExecuteAsync(url: string) {
		return UrlAsyncStream.fromUrlAsync(url).then(stream => {
			setImmediate(() => {
				// escape try/catch!
				this.loadAndExecuteAsync(stream, url);
			});
		});
	}

	executeFileAsync(file: File) {
		setImmediate(() => {
			// escape try/catch!
			this.loadAndExecuteAsync(new FileAsyncStream(file), '.');
		});
	}
}
