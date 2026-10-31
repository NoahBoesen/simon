export function startMessage(name: string, profileUrl: string, code: string) {
  return `Hi Simon! I'm ${name.trim()}.\nMy profile: ${profileUrl.trim()}\nI'm here for Night Hack and would love help meeting people.\nSTART ${code}`;
}

export function messagesLink(phone: string, body: string, apple = false) {
  return `sms:${phone}${apple ? "&" : "?"}body=${encodeURIComponent(body)}`;
}
