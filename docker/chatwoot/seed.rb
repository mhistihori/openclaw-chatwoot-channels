# Seeds a throwaway Chatwoot for local development: account, administrator, an API inbox
# with an AgentBot attached (so new conversations start as "pending"), and the webhook that
# points at the OpenClaw gateway. Safe to run twice. Prints one JSON line prefixed with SEED_RESULT=.
#
# Run: docker compose exec -T chatwoot-rails bundle exec rails runner /seed/seed.rb
require "json"
require "securerandom"

GATEWAY_URL = ENV.fetch("SEED_WEBHOOK_URL", "http://openclaw-gateway:18789/chatwoot/webhook")
ADMIN_EMAIL = ENV.fetch("SEED_ADMIN_EMAIL", "dev@example.test")
ADMIN_PASSWORD = ENV["SEED_ADMIN_PASSWORD"] || SecureRandom.alphanumeric(24) + "Aa1!"

account = Account.find_by(name: "OCW Dev") || Account.create!(name: "OCW Dev")

user = User.find_by(email: ADMIN_EMAIL)
unless user
  user = User.new(name: "Dev Admin", email: ADMIN_EMAIL, password: ADMIN_PASSWORD, password_confirmation: ADMIN_PASSWORD)
  user.skip_confirmation!
  user.save!
  AccountUser.create!(account: account, user: user, role: :administrator)
  created_user = true
end

channel = Channel::Api.find_by(account: account) || Channel::Api.create!(account: account)
inbox = channel.inbox || Inbox.create!(account: account, name: "OCW Dev API", channel: channel)

bot = AgentBot.find_by(account: account, name: "OpenClaw") ||
      AgentBot.create!(account: account, name: "OpenClaw", outgoing_url: GATEWAY_URL)
bot.update!(outgoing_url: GATEWAY_URL) if bot.outgoing_url != GATEWAY_URL
AgentBotInbox.find_or_create_by!(inbox: inbox, agent_bot: bot) if defined?(AgentBotInbox)
inbox.update!(agent_bot: bot) if inbox.respond_to?(:agent_bot=) && !defined?(AgentBotInbox)

result = {
  chatwoot_version: (Chatwoot.config[:version] rescue nil),
  account_id: account.id,
  inbox_id: inbox.id,
  inbox_identifier: channel.identifier,
  api_token: user.access_token.token,
  bot_id: bot.id,
  bot_token: (bot.access_token&.token rescue nil),
  bot_secret: (bot.respond_to?(:secret) ? bot.secret : nil),
  bot_columns: AgentBot.column_names,
  admin_email: ADMIN_EMAIL,
  admin_password: (created_user ? ADMIN_PASSWORD : nil)
}
puts "SEED_RESULT=#{result.to_json}"
