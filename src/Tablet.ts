import * as props from "./Props";
import * as util from "./Util";

export var adbkit = require('adbkit')
export var adbClient = adbkit.createClient()

export interface Device {
    id: string;
    type: string;
}

export interface Tracker {
    on(event: "add", listener: (dev: Device) => void): void;
    on(event: "remove", listener: (dev: Device) => void): void;
}

export interface TabletHost {
    playURL(t: Tablet, url: string, name: string): Promise<void>
    nameFromUrl(url: string): Promise<string>;
}

class VolumeControl extends props.WritablePropertyImpl<number> {
    private inHardNow?: number; // [0:15]
    private chagingValue = false;

    constructor(private readonly tbl: Tablet) {
        super("Volume", new props.SliderHTMLRenderer(), 0);
    }

    set(_val: number): void {
        const val = Math.max(0, Math.min(100, _val));
        this.setInternal(val);

        if (!this.chagingValue) {
            this.setVolume(val);
        }
    }

    public async setVolume(vol: number): Promise<number> {
        this.chagingValue = true;
        if (!this.inHardNow) {
            this.inHardNow = await this.getVolume();
        }
        
        while (Math.abs(this.inHardNow - this.get()*15/100) >= 1) {
            // console.log(this.inHardNow, "->", this.get()*15/100);
            let updown = "DOWN";
            if (this.inHardNow < this.get()*15/100) {
                updown = "UP";
            }
            await this.tbl.shellCmd("input keyevent KEYCODE_VOLUME_" + updown);
            if (updown === "DOWN") {
                this.inHardNow--;
            } else {
                this.inHardNow++;
            }
        }
        this.chagingValue = false;
        return this.inHardNow;
    }

    public async timerTask() {
        if (!this.chagingValue) {
            this.inHardNow = await this.getVolume()
            // console.log('inHardNow: ', this.inHardNow);
            this.setInternal(Math.min(100, Math.max(0, this.inHardNow*100/15)));
        }
    }

    private getVolume(): Promise<number> {
        return new Promise<number>((accept, reject) => {
            this.tbl.shellCmd('dumpsys audio | grep -E \'STREAM|Current|Mute\'')
                .then((str: string) => {
                    const allTheLines = str.split('- STREAM_');
                    const musicLines = allTheLines.filter(ll => ll.startsWith('MUSIC:'))[0];
                    if (!musicLines || musicLines.length < 0) {
                        reject(new Error("Empty resopnce of dumpsys audio"));
                        return;
                    }
                    const musicLinesArray = util.splitLines(musicLines);
                    const muteCountLine = musicLinesArray.filter(ll => ll.startsWith("   Mute count:"))[0];
                    const mutedLine = musicLinesArray.filter(ll => ll.startsWith("   Muted:"))[0];

                    if (!!mutedLine && mutedLine !== '   Muted: false') {
                        accept(0);
                    } else if (!!muteCountLine && muteCountLine !== '   Mute count: 0') {
                        accept(0);
                    } else {
                        const currentLineStart = "   Current:";
                        const currVolLine = musicLinesArray.filter(ll => ll.startsWith(currentLineStart))[0];
                        const allValues = currVolLine.substring(currentLineStart.length + 1).split(', ');
                        const currVol = allValues.filter(ll => ll.startsWith("2:"))[0];
                        if (!!currVol) {
                            //const maxVol = allValues.filter(ll => ll.startsWith("1000:"))[0];
                            const retVol = (+(currVol.split(': ')[1]));
                            // console.log('++>>', retVol);
                            accept(retVol);
                        } else {
                            const currVol = allValues.filter(ll => ll.startsWith("2 (speaker):"))[0];
                            const retVol = +(currVol.split(': ')[1]);
                            // console.log('-->>', retVol);
                            accept(retVol);
                        }

                    }
                })
                .catch(err => reject(err));
        });
    }

}

export class Tablet implements props.Controller {
    private _name: string;
    private _androidVersion: string;
    public get name() { return this._online ? `${this._name}, android ${this._androidVersion}` : "Offline"; }

    private _online: boolean = false;
    private _timer?: NodeJS.Timer;
    public get online() { return this._online; }

    constructor(
        public readonly id: string,
        public readonly shortName: string,
        private readonly app: TabletHost,
        private readonly tryToConnect: boolean) {
        this._name = id;
        this._androidVersion = "<Unknown>";

        const tbl = this;

        this.properties = [
            this.screenIsOn,
            this.volume,
            this.battery,
            this.playingUrl,
            props.newWritableProperty("Go play", "", new props.StringAndGoRendrer("Play"), (val) => {
                this.app.playURL(tbl, val, "");
            }),
            props.Button.create("Pause", () => this.shellCmd("am broadcast -a org.videolan.vlc.remote.Pause")),
            props.Button.create("Play", () => this.shellCmd("am broadcast -a org.videolan.vlc.remote.Play")),
            props.Button.create("Stop playing", () => this.stopPlaying()),
            props.Button.create("Reset", () => this.shellCmd("reboot")),
        ];
    }

    public volume = new VolumeControl(this);

    private battery = new props.PropertyImpl<string>("Battery", new props.SpanHTMLRenderer(), "");

    private playingUrl = new props.PropertyImpl<string>("Now playing", new props.SpanHTMLRenderer(), "");

    public screenIsOn = new (class TabletOnOffRelay extends props.Relay {
        constructor(private readonly tbl: Tablet) {
            super("Screen on");
        }

        public switch(on: boolean): Promise<void> {
            return this.tbl.screenIsSwitchedOn().then(onNow => {
                if (on !== onNow) {
                    return this.tbl.shellCmd("input keyevent KEYCODE_POWER").then(res => {
                        return util.delay(300).then(() => this.tbl.screenIsSwitchedOn().then(onNow => {
                            this.setInternal(onNow);
                            return Promise.resolve(void 0); // Already in this state
                        }));
                    })
                } else {
                    return Promise.resolve(void 0); // Already in this state
                }
            });
        }
   })(this);

    public readonly properties: props.Property<any>[];

    public serializable(): any {
        return {
            id: this.id,
            name: this.name
        }
    }

    private _connectingNow = false;

    private connectIfNeeded(): Promise<void> {
        if (!this._online && this.tryToConnect && !this._connectingNow) {
            // We should try to connect first
            const parse = this.id.match(/([^:]*):?(\d*)/);
            if (parse) {
                this._connectingNow = true;
                return new Promise<void>((accept, reject) => {
                    adbClient.connect(parse[1], +(parse[2])).then(() => {
                        this._connectingNow = false;
                        this.init()
                            .then(() => accept())
                            .catch(() => reject());
                    })
                        .catch(() => {
                            this._connectingNow = false;
                        });
                });
            }
        }
        return Promise.resolve(void 0);
    }

    public shellCmd(cmd: string): Promise<string> {
        // console.log(this.shortName, cmd);
        return this.connectIfNeeded().then(
            () => new Promise<string>((accept, reject) => {
                adbClient.shell(this.id, cmd)
                    .then(adbkit.util.readAll)
                    .then((output: string) => {
                        accept(output.toString());
                    })
                    .catch((err: Error) => reject(err));
            }));
    };

    public stopPlaying(): Promise<void> {
        return this.shellCmd("am force-stop org.videolan.vlc").then(() => void 0);
    }

    public playURL(url: string): Promise<void> {
        return this.stopPlaying().then(() => this.shellCmd(
            "am start -n org.videolan.vlc/org.videolan.vlc.gui.video.VideoPlayerActivity -a android.intent.action.VIEW -d \"" +
            url.replace("&", "\&") + "\" --ez force_fullscreen true")
            .then(() => {
                return Promise.resolve(void 0);
            }));
    }

    public getBatteryLevel(): Promise<number> {
        return this.shellCmd('dumpsys battery | grep level')
            .then((output: string) => {
                return +(output.split(':')[1]);
            });
    }

    public screenIsSwitchedOn(): Promise<boolean> {
        return new Promise<boolean>((accept, reject) => {
            const data: Map<string, string> = new Map([
                ["mHoldingWakeLockSuspendBlocker", ""],
                ["mWakefulness", ""]
            ]);

            this.shellCmd('dumpsys power | grep -E \'' + Array.from(data.keys()).join('|') + '\'')
                .then((output: string) => {
                    const str = output.toString();
                    const lines: string[] = str.split(/\r\n|\r|\n/);
                    for (const line of lines) {
                        const trimmed = line.trim();

                        Array.from(data.keys()).forEach(prop => {
                            if (trimmed.startsWith(prop + "=")) {
                                data.set(prop, trimmed.substring(prop.length + 1));
                            }
                        });
                    }

                    // console.log(this.name + "->" + JSON.stringify(data));
                    accept(data.get("mWakefulness") === "Awake");
                })
                .catch(err => reject(err));
        });
    }

    public init(): Promise<void> {
        // And then open shell
        return adbClient.getProperties(this.id).then((props: { [k: string]: string }) => {
            this._name = props['ro.product.model'];
            this._androidVersion = props['ro.build.version.release'];

            if (!this._timer) {
                this._timer = setInterval(() => {
                    this.timerTask();
                }, 10000);

                this.timerTask();
            }

            this._online = true;

            return void 0;
        });
    }

    public async timerTask() {
        this.screenIsOn.setInternal(await this.screenIsSwitchedOn());        
        await this.volume.timerTask();
        this.battery.setInternal(await this.getBatteryLevel() + "%");
        const url = await this.playingUrlNow();
        if (url) {
            this.app.nameFromUrl(url)
                .then(name => {
                    this.playingUrl.setInternal(name);
                })
                .catch(err => {
                    this.playingUrl.setInternal("Err");
                });        
        } else {
            this.playingUrl.setInternal("<nothing>");
        }
    }

    public playingUrlNow(): Promise<string | undefined> {
        return this.shellCmd("dumpsys activity activities | grep 'Intent {'").then(
            res => {
                const firstLine = util.splitLines(res)[0];
                // console.log("playingUrlNow", util.splitLines(res));
                const match = firstLine.match(/dat=(\S*)\s/);
                if (match) {
                    const url = match[1];
                    return url;
                }
                return undefined;
            }
        )
    }

    public stop() {
        if (!!this._timer) {
            clearInterval(this._timer);
        }
        this._online = false;
        // Try to connect
        this.connectIfNeeded();
    }
}
