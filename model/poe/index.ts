import {Chat, ChatOptions, ChatRequest, ChatResponse, ModelType} from "../base";
import {Browser, EventEmitter, Page} from "puppeteer";
import {BrowserPool, BrowserUser} from "../../pool/puppeteer";
import {
    DoneData,
    ErrorData,
    Event,
    EventStream,
    extractStrNumber,
    isSimilarity,
    maskLinks,
    MessageData,
    parseJSON,
    shuffleArray,
    sleep
} from "../../utils";
import {v4} from "uuid";
import fs from "fs";

const ModelMap: Partial<Record<ModelType, any>> = {
    [ModelType.GPT4]: 'GPT-4',
    [ModelType.Sage]: 'Sage',
    [ModelType.Claude]: 'Claude+',
    [ModelType.Claude100k]: 'Claude-instant-100k+',
    [ModelType.ClaudeInstance]: 'Claude-instant',
    [ModelType.GPT3p5Turbo]: 'ChatGPT',
    [ModelType.GPT3p5_16k]: 'ChatGPT-16k',
    [ModelType.Gpt4free]: '1GPT4Free',
    [ModelType.GooglePalm]: 'Google-PaLM',
    [ModelType.Claude2_100k]: 'Claude-2-100k',
    [ModelType.GPT4_32k]: 'GPT-4-32K',
    [ModelType.Llama_2_70b]: 'Llama-2-70b',
    [ModelType.Llama_2_13b]: 'Llama-2-13b',
    [ModelType.Llama_2_7b]: 'Llama-2-7b',
}


const MaxFailedTimes = 10;

type UseLeft = Partial<Record<ModelType, number>>;

type Account = {
    id: string;
    email?: string;
    login_time?: string;
    last_use_time?: string;
    pb: string;
    failedCnt: number;
    invalid?: boolean;
    use_left?: UseLeft;
}

type HistoryData = {
    data: {
        query: string;
        result: string;
        created_at: string;
    }[]
}

interface Messages {
    id: string;
    messageId: number;
    creationTime: number;
    clientNonce: null;
    state: string;
    text: string;
    author: string;
    linkifiedText: string;
    contentType: string;
    attachments: any[];
    vote: null;
    suggestedReplies: string[];
    linkifiedTextLengthOnCancellation: null;
    textLengthOnCancellation: null;
    voteReason: null;
    __isNode: string;
}

interface Data {
    messageAdded: Messages;
}

interface Payload {
    unique_id: string;
    subscription_name: string;
    data: Data;
}

interface RootObject {
    message_type: string;
    payload: Payload;
}

interface RealAck {
    messages: string[];
    min_seq: number;
}

class PoeAccountPool {
    private pool: Record<string, Account> = {};
    private using = new Set<string>();
    private readonly account_file_path = './run/account_poe.json';

    constructor() {
        const pbList = (process.env.POE_PB || '').split('|');
        if (fs.existsSync(this.account_file_path)) {
            const accountStr = fs.readFileSync(this.account_file_path, 'utf-8');
            this.pool = parseJSON(accountStr, {} as Record<string, Account>);
        } else {
            fs.mkdirSync('./run', {recursive: true});
            this.syncfile();
        }
        for (const key in this.pool) {
            this.pool[key].failedCnt = 0;
        }
        for (const pb of pbList) {
            if (this.pool[pb]) {
                continue;
            }
            this.pool[pb] = {
                id: v4(),
                pb,
                failedCnt: 0,
                invalid: false,
            };
        }
        console.log(`read poe account total:${Object.keys(this.pool).length}`)
        this.syncfile();
    }

    public syncfile() {
        fs.writeFileSync(this.account_file_path, JSON.stringify(this.pool));
    }

    public getByID(id: string) {
        for (const item in this.pool) {
            if (this.pool[item].id === id) {
                return this.pool[item];
            }
        }
    }

    public delete(id: string) {
        for (const v in this.pool) {
            const vv = this.pool[v];
        }
        this.using.delete(id);
        this.syncfile();
    }

    public get(): Account {
        for (const vv of Object.values(this.pool).sort((a, b) => (b.use_left?.[ModelType.GPT4] || 0) - (a.use_left?.[ModelType.GPT4]|| 0) )) {
            if (!vv.invalid && !this.using.has(vv.id)) {
                if (vv.use_left && vv.use_left[ModelType.GPT4] === 0 && vv.use_left[ModelType.GPT4_32k] === 0) {
                    vv.invalid = true;
                    continue;
                }
                this.using.add(vv.id);
                vv.failedCnt = 0;
                return vv;
            }
        }
        console.log('poe pb run out!!!!!!');
        return {
            id: v4(),
            pb: '',
            failedCnt: 0,
        } as Account
    }
}

interface PoeChatRequest extends ChatRequest {
    retry?: number;
}

export class Poe extends Chat implements BrowserUser<Account> {
    private pagePool: BrowserPool<Account>;
    private accountPool: PoeAccountPool;

    constructor(options?: ChatOptions) {
        super(options);
        this.accountPool = new PoeAccountPool();
        this.pagePool = new BrowserPool<Account>(+(process.env.POE_POOL_SIZE || 0), this, false);
    }

    support(model: ModelType): number {
        switch (model) {
            case ModelType.ClaudeInstance:
                return 4000;
            case ModelType.Claude100k:
                return 50000;
            case ModelType.Claude:
                return 4000;
            case ModelType.GPT4:
                return 4500;
            case ModelType.GPT3p5Turbo:
                return 3000;
            case ModelType.Llama_2_7b:
                return 3000;
            case ModelType.Llama_2_13b:
                return 3000;
            case ModelType.Llama_2_70b:
                return 3000;
            case ModelType.GPT3p5_16k:
                return 15000;
            case ModelType.Gpt4free:
                return 4000;
            case ModelType.Sage:
                return 4000;
            case ModelType.GooglePalm:
                return 4000;
            case ModelType.GPT4_32k:
                return 20000;
            case ModelType.Claude2_100k:
                return 80000
            default:
                return 0;
        }
    }

    public async ask(req: ChatRequest): Promise<ChatResponse> {
        const et = new EventStream();
        const res = await this.askStream(req, et);
        const result: ChatResponse = {
            content: '',
        };
        return new Promise(resolve => {
            et.read((event, data) => {
                if (!data) {
                    return;
                }
                switch (event) {
                    case 'message':
                        result.content += (data as MessageData).content;
                        break;
                    case 'done':
                        result.content += (data as DoneData).content;
                        break;
                    case 'error':
                        result.error += (data as ErrorData).error;
                        break;
                    default:
                        console.error(data);
                        break;
                }
            }, () => {
                resolve(result);
            });
        })
    }

    deleteID(id: string): void {
        this.accountPool.delete(id);
    }

    newID(): string {
        const account = this.accountPool.get();
        return account.id;
    }


    public static SelectorGpt4Left = '.SettingsSubscriptionSection_sectionBubble__nlU_b:nth-child(3) > .SettingsSubscriptionSection_countsSection__48sVJ > .SettingsSubscriptionSection_countRowContainer__ZJ419:nth-child(2) > .SettingsSubscriptionSection_countRow__GMItW > .SettingsSubscriptionSection_subtitle__Z7mcW:nth-child(2)';
    public static SelectorGpt4_32kLeft = '.SettingsSubscriptionSection_sectionBubble__nlU_b:nth-child(4) > .SettingsSubscriptionSection_countsSection__48sVJ > .SettingsSubscriptionSection_countRowContainer__ZJ419 > .SettingsSubscriptionSection_countRow__GMItW > .SettingsSubscriptionSection_subtitle__Z7mcW:nth-child(2)';
    public static SelectorGpt3_16kLeft = '.SettingsSubscriptionSection_sectionBubble__nlU_b:nth-child(5) > .SettingsSubscriptionSection_countsSection__48sVJ > .SettingsSubscriptionSection_countRowContainer__ZJ419 > .SettingsSubscriptionSection_countRow__GMItW > .SettingsSubscriptionSection_subtitle__Z7mcW:nth-child(2)';
    public static SelectorClaude2_100k = '.SettingsSubscriptionSection_sectionBubble__nlU_b:nth-child(1) > .SettingsSubscriptionSection_countsSection__48sVJ > .SettingsSubscriptionSection_countRowContainer__ZJ419:nth-child(2) > .SettingsSubscriptionSection_countRow__GMItW > .SettingsSubscriptionSection_subtitle__Z7mcW:nth-child(2)';

    public static async getUseLeft(page: Page): Promise<UseLeft> {
        await page.goto("https://poe.com/settings");
        return {
            [ModelType.GPT4]: await Poe.getSelectorCnt(page, Poe.SelectorGpt4Left),
            [ModelType.GPT4_32k]: await Poe.getSelectorCnt(page, Poe.SelectorGpt4_32kLeft),
            [ModelType.GPT3p5_16k]: await Poe.getSelectorCnt(page, Poe.SelectorGpt3_16kLeft),
            [ModelType.Claude2_100k]: await Poe.getSelectorCnt(page, Poe.SelectorClaude2_100k),
        };
    }

    public static async getSelectorCnt(page: Page, selector: string): Promise<number> {
        const v: string = await page.evaluate((arg1) => document.querySelector(arg1)?.textContent || '', selector);
        return extractStrNumber(v);
    }

    async init(id: string, browser: Browser): Promise<[Page | undefined, Account]> {
        const account = this.accountPool.getByID(id);
        if (!account) {
            await sleep(10 * 24 * 60 * 60 * 1000);
            return [] as any;
        }
        const page = await browser.newPage();
        try {
            await page.setCookie({name: 'p-b', value: account.pb, domain: 'poe.com'});
            await page.goto(`https://poe.com/GPT-4-32K`)
            if (!(await Poe.isLogin(page))) {
                account.invalid = true;
                this.accountPool.syncfile();
                throw new Error(`account:${account?.pb}, no login status`);
            }
            await page.waitForSelector(Poe.InputSelector, {timeout: 30 * 1000, visible: true});
            await page.click(Poe.InputSelector);
            await page.type(Poe.InputSelector, `1`);
            if (!(await Poe.isVIP(page))) {
                account.invalid = true;
                this.accountPool.syncfile();
                throw new Error(`account:${account?.pb}, not vip`);
            }
            account.use_left = await Poe.getUseLeft(page);
            this.accountPool.syncfile();
            console.log(`poe init ok! ${account.pb}`);
            return [page, account];
        } catch (e) {
            account.failedCnt += 1;
            this.accountPool.syncfile();
            console.warn(`account:${account?.pb}, something error happened.`, e);
            return [] as any;
        }
    }

    public static async isVIP(page: Page) {
        try {
            await page.waitForSelector(Poe.FreeModal, {timeout: 5 * 1000});
            return false;
        } catch (e) {
            return true;
        }
    }

    public static async isLogin(page: Page) {
        try {
            await page.waitForSelector(Poe.TalkToGpt, {timeout: 5 * 1000});
            return false;
        } catch (e) {
            return true;
        }
    }

    public static InputSelector = '.ChatPageMainFooter_footer__Hm4Rt > .ChatMessageInputFooter_footer__1cb8J > .ChatMessageInputContainer_inputContainer__SQvPA > .GrowingTextArea_growWrap___1PZM > .GrowingTextArea_textArea__eadlu';
    public static ClearSelector = '.ChatPageMainFooter_footer__Hm4Rt > .ChatMessageInputFooter_footer__1cb8J > .Button_buttonBase__0QP_m > svg > path';
    public static FreeModal = ".ReactModal__Body--open > .ReactModalPortal > .ReactModal__Overlay > .ReactModal__Content";
    public static TalkToGpt = "body > #__next > .LoggedOutBotInfoPage_layout__Y_z0i > .LoggedOutBotInfoPage_botInfo__r2z3X > .LoggedOutBotInfoPage_appButton__UO6NU";

    public static async clearContext(page: Page) {
        await page.waitForSelector(Poe.ClearSelector, {timeout: 10 * 60 * 1000});
        await page.click(Poe.ClearSelector);
    }

    public async askStream(req: PoeChatRequest, stream: EventStream) {
        req.prompt = req.prompt.replace(/assistant/g, 'result');
        req.prompt = maskLinks(req.prompt);
        if (req.model === ModelType.Claude2_100k || req.model === ModelType.Claude100k || req.model === ModelType.Claude || req.model === ModelType.ClaudeInstance) {
            const question = req.messages?.[req.messages.length - 1]?.content || '';

            req.prompt = `我会把我们的历史对话放在<history>标签内部，请你回答我的问题
<history>
${req.messages.slice(0, req.messages.length - 1).map(v => `${v.role === 'user' ? 'user: ' : 'result: '}${v.content}`).join('\n')}
</history>
${question}`;
        }
        const [page, account, done,
            destroy] = this.pagePool.get();
        if (!account || !page) {
            stream.write(Event.error, {error: 'please retry later!'});
            stream.write(Event.done, {content: ''})
            stream.end();
            return;
        }
        if (!((account.use_left?.[req.model] || 1) > 0)) {
            done(account);
            this.askStream(req, stream).then();
            console.log(`pb ${account.pb} ${req.model} left = 0, change pb ok!`);
            return;
        }
        if (account.use_left && account.use_left[req.model]) {
            console.log(`pb ${account.pb} ${req.model} left ${account.use_left[req.model]}`)
            //@ts-ignore
            account.use_left[req.model] -= 1;
            this.accountPool.syncfile();
        }
        let url = page?.url();
        if (!url) {
            await page?.reload();
            url = page?.url();
        }
        const target = ModelMap[req.model];
        console.log(`poe now in ${url}, target:${target}`,);
        if (!url?.endsWith(target)) {
            await page?.goto(`https://poe.com/${target}`);
            console.log(`poe go to ${target} ok`);
        }
        const client = await page.target().createCDPSession();
        await client.send('Network.enable');
        try {
            let old = '';
            let et: EventEmitter;
            const tt = setTimeout(async () => {
                client.removeAllListeners('Network.webSocketFrameReceived');
                await Poe.clearContext(page);
                await sleep(2000);
                account.failedCnt += 1;
                this.accountPool.syncfile();
                if (account.failedCnt >= MaxFailedTimes) {
                    destroy(true);
                    this.accountPool.syncfile();
                    console.log(`poe account failed cnt > 10, destroy ok`);
                } else {
                    await page.reload();
                    done(account);
                }
                if (!stream.stream().writableEnded && !stream.stream().closed) {
                    if ((req?.retry || 0) > 3) {
                        console.log('poe try times > 3, return error');
                        stream.write(Event.error, {error: 'please retry later!'});
                        stream.write(Event.done, {content: ''})
                        stream.end();
                        return;
                    }
                    console.error(`pb ${account.pb} wait ack ws timeout, retry! failedCnt:${account.failedCnt}`);
                    req.retry = req.retry ? req.retry + 1 : 1;
                    await this.askStream(req, stream);
                }
            }, 20 * 1000);
            let currMsgID = '';
            et = client.on('Network.webSocketFrameReceived', async ({response}) => {
                tt.refresh();
                const data = parseJSON(response.payloadData, {} as RealAck);
                const obj = parseJSON(data.messages[0], {} as RootObject);
                const {unique_id} = obj.payload || {};
                const message = obj?.payload?.data?.messageAdded;
                if (!message) {
                    return;
                }
                const {author, state, text} = message;
                // console.log(author, state, text, unique_id);

                if (author === 'chat_break') {
                    return;
                }
                if (author === 'human' && isSimilarity(text, req.prompt)) {
                    currMsgID = unique_id;
                    return;
                }
                if (unique_id !== currMsgID) {
                    // console.log(`message id different`, {unique_id, currMsgID});
                    return;
                }
                if (text.indexOf(`Sorry, you've exceeded your monthly usage limit for this bot`) !== -1) {
                    clearTimeout(tt);
                    client.removeAllListeners('Network.webSocketFrameReceived');
                    account.invalid = true;
                    destroy(true);
                    await this.askStream(req, stream);
                    return;
                }
                switch (state) {
                    case 'complete':
                        clearTimeout(tt);
                        client.removeAllListeners('Network.webSocketFrameReceived');
                        if (text.length > old.length) {
                            stream.write(Event.message, {content: text.substring(old.length)});
                        }
                        stream.write(Event.done, {content: ''});
                        stream.end();
                        await Poe.clearContext(page);
                        await sleep(2000);
                        account.failedCnt = 0;
                        this.accountPool.syncfile();
                        done(account);
                        console.log('poe recv msg complete');
                        return;
                    case 'incomplete':
                        if (text.length > old.length) {
                            stream.write(Event.message, {content: text.substring(old.length)});
                            old = text;
                        }
                        return;
                }
            })
            console.log('poe start send msg');
            await Poe.clearContext(page);
            await page.waitForSelector(Poe.InputSelector)
            await page.click(Poe.InputSelector);
            await page.type(Poe.InputSelector, `1`);
            console.log('poe find input ok');
            const input = await page.$(Poe.InputSelector);
            //@ts-ignore
            await input?.evaluate((el, content) => el.value = content, req.prompt);
            await page.keyboard.press('Enter');
            console.log('send msg ok!');
        } catch (e) {
            client.removeAllListeners('Network.webSocketFrameReceived');
            console.error(`account: pb=${account.pb}, poe ask stream failed:`, e);
            account.failedCnt += 1;
            if (account.failedCnt >= MaxFailedTimes) {
                destroy(true);
                this.accountPool.syncfile();
                console.log(`poe account failed cnt > 10, destroy ok`);
            } else {
                this.accountPool.syncfile();
                await page.reload();
                done(account);
            }
            done(account);
            stream.write(Event.error, {error: 'some thing error, try again later'});
            stream.write(Event.done, {content: ''})
            stream.end();
            return
        }
    }
}
