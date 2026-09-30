import { common } from '@kit.AbilityKit';
import { DshAgent, DshAnswer, DshEvent, DshParameter, DshTool, DshToolContext } from '../dsh/DshAgent';

interface ChatLine { id: number; role: string; text: string; }
interface PendingApproval { requestId: string; toolName: string; }
interface NoteList { titles: string[]; }
interface DeleteResult { deleted: boolean; title: string; }
interface MessagePart { type?: string; text?: string; }
interface MessageData { content?: MessagePart[]; message?: MessageData; source?: SourceData; }
interface SourceData { kind?: string; }
interface SessionEvent { type?: string; data?: MessageData; }
interface QuestionOption { label: string; }
interface QuestionItem { id: string; question: string; options?: QuestionOption[]; }
interface PendingQuestion { requestId: string; questions: QuestionItem[]; }

// A minimal chat on DSH Runtime for HarmonyOS with two app tools:
// list_notes (read: runs directly) and delete_note (write: asks for approval first).
@Entry
@Component
struct Index {
  @State apiKey: string = '';
  @State draft: string = '';
  @State lines: ChatLine[] = [];
  @State status: string = 'Enter a DeepSeek API key to start';
  @State approval: PendingApproval | undefined = undefined;
  @State question: PendingQuestion | undefined = undefined;
  // UI state: `agent` itself is not observed, so the chat view switches on this flag.
  @State started: boolean = false;
  private agent?: DshAgent;
  private notes: string[] = ['Groceries', 'Meeting notes', 'Ideas'];
  private nextLine: number = 0;
  // A new conversation per launch keeps the demo simple; sessions persist in <filesDir>/dsh.
  private sessionId: string = 'demo-' + Date.now().toString();

  private tools(): DshTool[] {
    const listNotes: DshTool = {
      name: 'list_notes', description: 'List the titles of the user notes.', effect: 'read',
      execute: async (_args: Record<string, Object>, _context: DshToolContext): Promise<Object> => {
        const result: NoteList = { titles: this.notes };
        return result;
      }
    };
    const title: DshParameter = { type: 'string', required: true, description: 'Exact note title' };
    const parameters: Record<string, DshParameter> = { 'title': title };
    const deleteNote: DshTool = {
      name: 'delete_note', description: 'Delete one note by its exact title.', effect: 'write', parameters: parameters,
      execute: async (args: Record<string, Object>, _context: DshToolContext): Promise<Object> => {
        const target = String(args['title']);
        const before = this.notes.length;
        this.notes = this.notes.filter((note: string): boolean => note !== target);
        const result: DeleteResult = { deleted: this.notes.length < before, title: target };
        return result;
      }
    };
    return [listNotes, deleteNote];
  }

  private add(role: string, text: string): void {
    this.lines = this.lines.concat([{ id: this.nextLine++, role: role, text: text }]);
  }

  private onEvent(event: DshEvent): void {
    if (event.method === 'session.status') this.status = event.params['status'] === 'running' ? 'Working…' : 'Ready';
    else if (event.method === 'session.runtime.error') this.add('error', String(event.params['message']));
    else if (event.method === 'approval.requested') {
      this.approval = { requestId: String(event.params['requestId']), toolName: String(event.params['toolName']) };
    } else if (event.method === 'approval.resolved') this.approval = undefined;
    else if (event.method === 'question.requested') {
      this.question = { requestId: String(event.params['requestId']), questions: event.params['questions'] as QuestionItem[] };
    } else if (event.method === 'question.resolved') this.question = undefined;
    else if (event.method === 'session.event') {
      const record = event.params['event'] as SessionEvent;
      const data = record.data?.message ?? record.data;
      // Only answer text: reasoning parts are the model's private thinking.
      const text = (data?.content ?? []).filter((part: MessagePart): boolean => part.type === 'text')
        .map((part: MessagePart): string => part.text ?? '').join('');
      if (record.type === 'assistant/message' && text) this.add('assistant', text);
      else if (record.type === 'user/message' && data?.source?.kind === 'user' && text) this.add('user', text);
    }
  }

  private async start(): Promise<void> {
    const key = this.apiKey.trim();
    if (!key) return;
    this.status = 'Starting…';
    try {
      this.agent = await DshAgent.create(this.getUIContext().getHostContext() as common.UIAbilityContext, {
        provider: 'deepseek', model: 'deepseek-flash', providers: { 'deepseek': { preset: 'deepseek' } },
        apiKey: async (_provider: string): Promise<string> => key,
        tools: this.tools(),
        instructions: 'You help the user manage their notes. Use the tools; never invent note titles.'
      });
      this.agent.onEvent((event: DshEvent): void => this.onEvent(event));
      this.status = 'Ready (DSH ' + this.agent.dshVersion + ')';
      this.started = true;
    } catch (error) {
      this.status = 'Failed to start: ' + (error as Error).message;
    }
  }

  private async send(): Promise<void> {
    const text = this.draft.trim();
    if (!text || !this.agent) return;
    this.draft = '';
    try { await this.agent.send(this.sessionId, text); } catch (error) { this.add('error', (error as Error).message); }
  }

  private decide(allow: boolean): void {
    const pending = this.approval;
    if (!pending || !this.agent) return;
    this.agent.resolveApproval(pending.requestId, allow).catch((error: Error): void => this.add('error', error.message));
  }

  // Answers the first question with the chosen option; any further questions are skipped.
  private answer(label: string): void {
    const pending = this.question;
    if (!pending || !this.agent) return;
    const answers: DshAnswer[] = pending.questions.map((item: QuestionItem, index: number): DshAnswer =>
      ({ id: item.id, selected: index === 0 ? [label] : [] }));
    this.agent.answerQuestion(pending.requestId, answers).catch((error: Error): void => this.add('error', error.message));
  }

  private dismiss(): void {
    const pending = this.question;
    if (!pending || !this.agent) return;
    this.agent.dismissQuestion(pending.requestId).catch((error: Error): void => this.add('error', error.message));
  }

  aboutToDisappear(): void {
    this.agent?.dispose();
  }

  build() {
    Column({ space: 8 }) {
      Text('DSH Runtime for HarmonyOS').fontSize(20).fontWeight(FontWeight.Bold)
      Text(this.status).id('status').fontSize(14)
      if (!this.started) {
        TextInput({ placeholder: 'DeepSeek API key', text: this.apiKey })
          .type(InputType.Password)
          .onChange((value: string): void => { this.apiKey = value; })
        Button('Start').id('start').onClick((): void => { this.start(); })
      } else {
        List({ space: 6 }) {
          ForEach(this.lines, (line: ChatLine) => {
            ListItem() {
              Text((line.role === 'user' ? 'You: ' : line.role === 'assistant' ? 'Agent: ' : 'Error: ') + line.text)
                .fontSize(15)
            }
          }, (line: ChatLine): string => line.id.toString())
        }
        .layoutWeight(1)
        if (this.question && this.question.questions.length > 0) {
          Column({ space: 6 }) {
            Text(this.question.questions[0].question).fontWeight(FontWeight.Medium)
            Flex({ wrap: FlexWrap.Wrap }) {
              ForEach(this.question.questions[0].options ?? [], (option: QuestionOption) => {
                Button(option.label).margin(4).onClick((): void => this.answer(option.label))
              }, (option: QuestionOption): string => option.label)
              Button('Skip').id('skipQuestion').margin(4).onClick((): void => this.dismiss())
            }
          }
        }
        if (this.approval) {
          Column({ space: 6 }) {
            Text('Allow ' + this.approval.toolName + '?').fontWeight(FontWeight.Medium)
            Row({ space: 12 }) {
              Button('Allow').id('allow').onClick((): void => this.decide(true))
              Button('Reject').id('reject').onClick((): void => this.decide(false))
            }
          }
        }
        Row({ space: 8 }) {
          TextInput({ placeholder: 'Ask about your notes', text: this.draft })
            .layoutWeight(1)
            // No send on Enter: with a Chinese IME, Enter can confirm a half-composed word.
            .onChange((value: string): void => { this.draft = value; })
          Button('Send').id('send').onClick((): void => { this.send(); })
        }
      }
    }
    .padding(16)
    .width('100%')
    .height('100%')
  }
}
