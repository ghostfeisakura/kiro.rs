import { useState, useRef } from 'react'
import { Upload, CheckCircle2, XCircle, Loader2, FileJson } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { addCredential } from '@/api/credentials'
import { extractErrorMessage } from '@/lib/utils'
import type { AddCredentialRequest } from '@/types/api'

// ---- Types ----

interface ParsedCredential {
  request: AddCredentialRequest
  label: string
}

interface ImportResult {
  label: string
  success: boolean
  message: string
}

type Step = 'select' | 'preview' | 'importing' | 'complete'

// ---- Format Detection & Parsing ----

interface KiroAccount {
  email?: string
  nickname?: string
  idp?: string
  ssoRegion?: string
  credentials?: {
    refreshToken?: string
    clientId?: string
    clientSecret?: string
    region?: string
  }
}

interface KiroAccountsFile {
  version?: string
  accounts?: KiroAccount[]
}

interface NativeCredential {
  refreshToken?: string
  authMethod?: string
  clientId?: string
  clientSecret?: string
  region?: string
  priority?: number
}

function parseKiroAccounts(data: KiroAccountsFile): ParsedCredential[] {
  if (!data.accounts || !Array.isArray(data.accounts)) {
    throw new Error('无效的 kiro-accounts 格式：缺少 accounts 数组')
  }

  return data.accounts.map((account, index) => {
    const refreshToken = account.credentials?.refreshToken
    if (!refreshToken) {
      throw new Error(`账号 #${index + 1} 缺少 refreshToken`)
    }

    const request: AddCredentialRequest = {
      refreshToken,
      authMethod: account.idp === 'BuilderId' ? 'idc' : 'social',
      region: account.ssoRegion || account.credentials?.region || undefined,
      priority: index,
    }

    if (account.credentials?.clientId) {
      request.clientId = account.credentials.clientId
    }
    if (account.credentials?.clientSecret) {
      request.clientSecret = account.credentials.clientSecret
    }

    const label = account.email || account.nickname || `账号 #${index + 1}`
    return { request, label }
  })
}

function parseNativeCredentials(
  data: NativeCredential | NativeCredential[]
): ParsedCredential[] {
  const items = Array.isArray(data) ? data : [data]

  return items.map((item, index) => {
    if (!item.refreshToken) {
      throw new Error(`凭据 #${index + 1} 缺少 refreshToken`)
    }

    const request: AddCredentialRequest = {
      refreshToken: item.refreshToken,
      authMethod:
        item.authMethod === 'idc' || item.authMethod === 'social'
          ? item.authMethod
          : 'social',
      region: item.region || undefined,
      clientId: item.clientId || undefined,
      clientSecret: item.clientSecret || undefined,
      priority: item.priority ?? index,
    }

    return {
      request,
      label: `凭据 #${index + 1} (${request.authMethod})`,
    }
  })
}

function parseFile(json: unknown): {
  credentials: ParsedCredential[]
  format: string
} {
  if (typeof json !== 'object' || json === null) {
    throw new Error('无效的 JSON 格式')
  }

  // kiro-accounts format: has 'accounts' array
  if ('accounts' in json && Array.isArray((json as KiroAccountsFile).accounts)) {
    const credentials = parseKiroAccounts(json as KiroAccountsFile)
    return { credentials, format: 'kiro-accounts' }
  }

  // Native kiro-rs format
  const credentials = parseNativeCredentials(
    json as NativeCredential | NativeCredential[]
  )
  return { credentials, format: 'kiro-rs' }
}

// ---- Component ----

interface ImportCredentialsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ImportCredentialsDialog({
  open,
  onOpenChange,
}: ImportCredentialsDialogProps) {
  const [step, setStep] = useState<Step>('select')
  const [credentials, setCredentials] = useState<ParsedCredential[]>([])
  const [format, setFormat] = useState('')
  const [results, setResults] = useState<ImportResult[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [fileName, setFileName] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()

  const reset = () => {
    setStep('select')
    setCredentials([])
    setFormat('')
    setResults([])
    setCurrentIndex(0)
    setFileName('')
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      reset()
    }
    onOpenChange(open)
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setFileName(file.name)

    const reader = new FileReader()
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target?.result as string)
        const parsed = parseFile(json)

        if (parsed.credentials.length === 0) {
          throw new Error('文件中没有找到可导入的凭据')
        }

        setCredentials(parsed.credentials)
        setFormat(parsed.format)
        setStep('preview')
      } catch (err) {
        const message =
          err instanceof Error ? err.message : '文件解析失败'
        setCredentials([])
        setFormat('')
        setStep('select')
        // 在 select 步骤中显示错误信息
        alert(`解析失败: ${message}`)
      }
    }
    reader.readAsText(file)
  }

  const handleImport = async () => {
    setStep('importing')
    setResults([])
    setCurrentIndex(0)

    const importResults: ImportResult[] = []

    for (let i = 0; i < credentials.length; i++) {
      setCurrentIndex(i)
      const cred = credentials[i]

      try {
        const resp = await addCredential(cred.request)
        importResults.push({
          label: cred.label,
          success: true,
          message: resp.message,
        })
      } catch (error: unknown) {
        importResults.push({
          label: cred.label,
          success: false,
          message: extractErrorMessage(error),
        })
      }

      setResults([...importResults])
    }

    // 刷新凭据列表
    queryClient.invalidateQueries({ queryKey: ['credentials'] })
    setStep('complete')
  }

  const successCount = results.filter((r) => r.success).length
  const failCount = results.filter((r) => !r.success).length

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === 'select' && '导入凭据'}
            {step === 'preview' && '确认导入'}
            {step === 'importing' && '导入中...'}
            {step === 'complete' && '导入完成'}
          </DialogTitle>
        </DialogHeader>

        {/* Step 1: File Selection */}
        {step === 'select' && (
          <div className="py-4">
            <p className="text-sm text-muted-foreground mb-4">
              支持 kiro-accounts 导出格式和 kiro-rs 原生 credentials 格式的 JSON 文件。
            </p>
            <div
              className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
              <p className="text-sm font-medium mb-1">点击选择 JSON 文件</p>
              <p className="text-xs text-muted-foreground">
                支持 .json 格式
              </p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleFileSelect}
            />
          </div>
        )}

        {/* Step 2: Preview */}
        {step === 'preview' && (
          <div className="py-4 space-y-4">
            <div className="flex items-center gap-2 text-sm">
              <FileJson className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">{fileName}</span>
              <Badge variant="secondary">{format}</Badge>
              <Badge variant="outline">{credentials.length} 个凭据</Badge>
            </div>

            <div className="max-h-64 overflow-y-auto space-y-2">
              {credentials.map((cred, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-md border p-3 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{cred.label}</div>
                    <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                      <span>{cred.request.authMethod}</span>
                      {cred.request.region && (
                        <span>· {cred.request.region}</span>
                      )}
                      <span>· 优先级 {cred.request.priority}</span>
                    </div>
                  </div>
                  {cred.request.clientId && (
                    <Badge variant="outline" className="ml-2 shrink-0 text-xs">
                      有 Client
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Step 3: Importing */}
        {step === 'importing' && (
          <div className="py-4 space-y-4">
            <div className="flex items-center justify-between text-sm">
              <span>
                正在导入... ({currentIndex + 1}/{credentials.length})
              </span>
              <span className="text-muted-foreground">
                {Math.round(((currentIndex + 1) / credentials.length) * 100)}%
              </span>
            </div>

            {/* Progress bar */}
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full bg-primary transition-all"
                style={{
                  width: `${((currentIndex + 1) / credentials.length) * 100}%`,
                }}
              />
            </div>

            <div className="max-h-48 overflow-y-auto space-y-1.5">
              {credentials.map((cred, i) => {
                const result = results[i]
                return (
                  <div
                    key={i}
                    className="flex items-center gap-2 text-sm py-1"
                  >
                    {i === currentIndex && !result && (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                    )}
                    {result?.success && (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
                    )}
                    {result && !result.success && (
                      <XCircle className="h-4 w-4 shrink-0 text-red-500" />
                    )}
                    {i > currentIndex && (
                      <div className="h-4 w-4 shrink-0 rounded-full border border-muted-foreground/30" />
                    )}
                    <span className="truncate">{cred.label}</span>
                    {result && !result.success && (
                      <span className="text-xs text-red-500 truncate ml-auto">
                        {result.message}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Step 4: Complete */}
        {step === 'complete' && (
          <div className="py-4 space-y-4">
            <div className="flex items-center gap-3">
              {failCount === 0 ? (
                <CheckCircle2 className="h-8 w-8 text-green-500" />
              ) : (
                <XCircle className="h-8 w-8 text-yellow-500" />
              )}
              <div>
                <div className="font-medium">
                  成功 {successCount} 个
                  {failCount > 0 && `，失败 ${failCount} 个`}
                </div>
                <div className="text-sm text-muted-foreground">
                  共 {credentials.length} 个凭据
                </div>
              </div>
            </div>

            {failCount > 0 && (
              <div className="max-h-48 overflow-y-auto space-y-1.5">
                {results
                  .filter((r) => !r.success)
                  .map((r, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 text-sm text-red-500 py-1"
                    >
                      <XCircle className="h-4 w-4 shrink-0" />
                      <span className="truncate">{r.label}</span>
                      <span className="text-xs ml-auto truncate">
                        {r.message}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {step === 'select' && (
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              取消
            </Button>
          )}

          {step === 'preview' && (
            <>
              <Button variant="outline" onClick={reset}>
                重新选择
              </Button>
              <Button onClick={handleImport}>
                <Upload className="h-4 w-4 mr-2" />
                开始导入 ({credentials.length})
              </Button>
            </>
          )}

          {step === 'complete' && (
            <Button onClick={() => handleOpenChange(false)}>完成</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
