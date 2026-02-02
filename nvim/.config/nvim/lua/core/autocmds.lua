local function augroup(name)
	return vim.api.nvim_create_augroup("lazyvim_" .. name, { clear = true })
end
local M = {}

M.setup = function()
	-- Highlight on yank
	vim.api.nvim_create_autocmd("TextYankPost", {
		group = augroup("highlight_yank"),
		callback = function()
			(vim.hl or vim.highlight).on_yank()
		end,
	})
end

return M
