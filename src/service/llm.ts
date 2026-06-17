import { Context, Service } from 'koishi'
import { Config } from '../config'
import {
    AnalysisPromptContext,
    GoldenQuote,
    QueryIntent,
    SummaryTopic,
    UserPersonaProfile,
    UserStats,
    UserTitle
} from '../types'
import { load } from 'js-yaml'

export class LLMService extends Service {
    constructor(
        ctx: Context,
        public config: Config
    ) {
        super(ctx, 'group_analysis_llm', true)
    }

    private async _callOpenAI(
        prompt: string,
        taskName: string
    ): Promise<string> {
        const logger = this.ctx.logger

        const endpoint = this.config.openaiEndpoint.replace(/\/$/, '')
        const url = `${endpoint}/chat/completions`

        logger.info(`正在调用 OpenAI API 进行 ${taskName}...`)

        const response = await this.ctx.http.post(url, {
            model: this.config.openaiModel,
            messages: [
                { role: 'user', content: prompt }
            ],
            temperature: this.config.temperature ?? 1
        }, {
            headers: {
                'Authorization': `Bearer ${this.config.openaiApiKey}`,
                'Content-Type': 'application/json'
            }
        })

        const rawContent = response?.choices?.[0]?.message?.content

        if (!rawContent) {
            logger.error(`OpenAI API 返回空响应: ${JSON.stringify(response)}`)
            throw new Error(`OpenAI API 返回空响应 (${taskName})`)
        }

        logger.info(`LLM 原始响应: ${rawContent || '[空响应]'}`)

        return rawContent
    }

    private async _callLLM<T>(
        prompt: string,
        taskName: string
    ): Promise<T> {
        const rawContent = await this._callOpenAI(prompt, taskName)

        // Extract YAML from markdown code block (supports both yaml and yml)
        const yamlMatch = rawContent.match(/```ya?ml\s*([\s\S]*?)\s*```/)
        if (!yamlMatch) {
            this.ctx.logger.warn(`未找到 YAML 代码块，无法解析。`)
            throw new Error('未找到 YAML 响应。')
        }

        try {
            const data = load(yamlMatch[1]) as T
            if (Array.isArray(data)) {
                this.ctx.logger.info(`成功解析 ${data.length} 条数据。`)
            }
            return data
        } catch (err) {
            this.ctx.logger.error('解析 YAML 失败:', err)
            this.ctx.logger.error(
                '待解析的 YAML 字符串:',
                yamlMatch[1] || '[空字符串]'
            )
            throw err
        }
    }

    private async _callText(
        prompt: string,
        taskName: string
    ): Promise<string> {
        const rawContent = await this._callOpenAI(prompt, taskName)
        return rawContent
    }

    private formatTimeRange(context?: AnalysisPromptContext): string {
        if (!context?.timeRange) return '（未指定）'

        const { start, end, description } = context.timeRange
        const format = (date?: Date) =>
            date ? date.toLocaleString('zh-CN', { hour12: false }) : '（未知）'
        const rangeText = `${format(start)} ~ ${format(end)}`
        return description ? `${description} (${rangeText})` : rangeText
    }

    private fillAnalysisPrompt(
        template: string,
        context?: AnalysisPromptContext
    ): string {
        const keywordsText =
            context?.keywords?.length > 0
                ? context.keywords.join('、')
                : '（无）'
        const topicsText =
            context?.topics?.length > 0 ? context.topics.join('、') : '（无）'
        const nicknamesText =
            context?.nicknames?.length > 0
                ? context.nicknames.join('、')
                : '（无）'
        const queryText = context?.query || '（无）'
        const timeRangeText = this.formatTimeRange(context)

        return template
            .replace('{keywords}', keywordsText)
            .replace('{topics}', topicsText)
            .replace('{nicknames}', nicknamesText)
            .replace('{query}', queryText)
            .replace('{timeRange}', timeRangeText)
    }

    public async summarizeTopics(
        messagesText: string,
        context?: AnalysisPromptContext
    ): Promise<SummaryTopic[]> {
        const prompt = this.fillAnalysisPrompt(
            this.config.promptTopic
                .replace('{messages}', messagesText)
                .replace('{maxTopics}', this.config.maxTopics.toString()),
            context
        )
        return this._callLLM<SummaryTopic[]>(prompt, '话题分析').then(
            (data) => data ?? []
        )
    }

    public async analyzeUserTitles(
        users: UserStats[],
        context?: AnalysisPromptContext
    ): Promise<UserTitle[]> {
        const userSummaries = users
            .sort((a, b) => b.messageCount - a.messageCount)
            .slice(0, this.config.maxUserTitles)
            .map(
                (user) =>
                    `- ${user.nickname} (QQ:${user.userId}): ` +
                    `发言${user.messageCount}条, 平均${user.avgChars}字, ` +
                    `表情比例${user.emojiRatio}, 夜间发言比例${user.nightRatio}, ` +
                    `回复比例${user.replyRatio}`
            )
            .join('\n')

        const prompt = this.fillAnalysisPrompt(
            this.config.promptUserTitles.replace('{users}', userSummaries),
            context
        )
        return this._callLLM<UserTitle[]>(prompt, '用户称号分析').then(
            (data) => data ?? []
        )
    }

    public async analyzeGoldenQuotes(
        messagesText: string,
        maxQuotes: number,
        context?: AnalysisPromptContext
    ): Promise<GoldenQuote[]> {
        const prompt = this.fillAnalysisPrompt(
            this.config.promptGoldenQuotes
                .replace('{messages}', messagesText)
                .replace('{maxGoldenQuotes}', String(maxQuotes)),
            context
        )
        return this._callLLM<GoldenQuote[]>(prompt, '金句分析').then(
            (data) => data ?? []
        )
    }

    public async analyzeUserPersona(
        userId: string,
        username: string,
        roles: string[],
        recentMessages: string,
        previousAnalysis?: string
    ): Promise<UserPersonaProfile | null> {
        const filledPrompt = this.config.promptUserPersona
            .replace('{messages}', recentMessages || '（最近暂无发言记录）')
            .replace(
                '{previousAnalysis}',
                previousAnalysis || '（无历史画像，请从零开始）'
            )
            .replace('{roles}', roles?.join(', ') || '（未知角色）')
            .replace('{userId}', userId)
            .replace('{username}', username || userId)
            .replace(
                '{personaLookbackDays}',
                String(this.config.personaLookbackDays)
            )

        const resultArray = await this._callLLM<UserPersonaProfile[]>(
            filledPrompt,
            '用户画像分析'
        )
        const result = resultArray[0] || null
        if (!result) return null
        result.username = username
        return result
    }

    public async parseGroupQuery(promptContext: {
        query: string
        currentTime: string
        timeZone: string
        platform: string
        groupName: string
        guildId?: string
        channelId?: string
        currentUserId?: string
        currentUserName?: string
    }): Promise<QueryIntent | null> {
        const prompt = this.config.promptQueryParser
            .replace('{currentTime}', promptContext.currentTime)
            .replace('{timeZone}', promptContext.timeZone)
            .replace('{platform}', promptContext.platform)
            .replace('{groupName}', promptContext.groupName || '未知群聊')
            .replace('{guildId}', promptContext.guildId || '')
            .replace('{channelId}', promptContext.channelId || '')
            .replace('{currentUserId}', promptContext.currentUserId || '')
            .replace('{currentUserName}', promptContext.currentUserName || '')
            .replace('{query}', promptContext.query)

        try {
            const intent = await this._callLLM<QueryIntent>(
                prompt,
                '群分析请求解析'
            )
            return intent ?? null
        } catch (error) {
            this.ctx.logger.warn('解析群分析请求失败:', error)
            return null
        }
    }

    public async replyGroupQuery(promptContext: {
        query: string
        analysisResult: string
        currentTime: string
        groupName: string
        guildId?: string
        channelId?: string
        currentUserId?: string
        currentUserName?: string
    }): Promise<string | null> {
        const prompt = this.config.promptQueryChat
            .replace('{currentTime}', promptContext.currentTime)
            .replace('{groupName}', promptContext.groupName || '未知群聊')
            .replace('{guildId}', promptContext.guildId || '')
            .replace('{channelId}', promptContext.channelId || '')
            .replace('{currentUserId}', promptContext.currentUserId || '')
            .replace('{currentUserName}', promptContext.currentUserName || '')
            .replace('{query}', promptContext.query)
            .replace('{analysisResult}', promptContext.analysisResult || '')

        return this._callText(prompt, '群分析对话回复')
    }
}

declare module 'koishi' {
    interface Context {
        group_analysis_llm: LLMService
    }
}
