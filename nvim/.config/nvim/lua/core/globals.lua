local M = {}

local function open_nvim_tree()
	require("nvim-tree.api").tree.open()
end

M.setup = function()
	vim.g.mapleader = " "
	vim.g.loaded_netrw = 1
	vim.g.loaded_netrwPlugin = 1
	vim.api.nvim_create_autocmd({ "VimEnter" }, { callback = open_nvim_tree })
end

return M
