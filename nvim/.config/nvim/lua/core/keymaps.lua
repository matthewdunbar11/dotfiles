local M = {}

M.setup = function()
	-- Remap pane navigation in normal mode
	-- vim.keymap.set("n", "<C-h>", "<C-w>h", { noremap = true, silent = true }) -- Move to left pane
	-- vim.keymap.set("n", "<C-j>", "<C-w>j", { noremap = true, silent = true }) -- Move to down pane
	-- vim.keymap.set("n", "<C-k>", "<C-w>k", { noremap = true, silent = true }) -- Move to up pane
	-- vim.keymap.set("n", "<C-l>", "<C-w>l", { noremap = true, silent = true }) -- Move to right pane
	--
	vim.keymap.set("n", "<SPACE>", "<NOP>")
	vim.keymap.set("i", "jk", "<ESC>")
	vim.keymap.set("n", "<leader>h", ":noh<CR>") -- not needed, duplicate of <C-L>

	vim.keymap.set("n", "<leader><leader>e", [[:luafile %<CR>]])

	-- resizing splits
	vim.keymap.set("n", "<leader>[", ":vertical resize -3<CR>")
	vim.keymap.set("n", "<leader>]", ":vertical resize +3<CR>")

	-- indenting
	vim.keymap.set("v", ">", ">gv", { desc = "indent right" })
	vim.keymap.set("v", "<", "<gv", { desc = "indent left" })

	-- clipboard
	vim.keymap.set("v", "<leader>y", '"+y')
	vim.keymap.set("n", "<leader>Y", '"+yg_')
	vim.keymap.set("n", "<leader>y", '"+y')
	vim.keymap.set("n", "<leader>yy", '"+yy')
	vim.keymap.set("n", "<leader>p", '"+p')
	vim.keymap.set("n", "<leader>p", '"+p')
	vim.keymap.set("v", "<leader>p", '"+p')
	vim.keymap.set("v", "<leader>p", '"+p')

	-- quickfix lists
	vim.keymap.set("n", "<leader>ox", ":copen<CR>", { desc = "[O]pen Quickfi[x] List" })
	vim.keymap.set("n", "<leader>cx", ":cclose<CR>", { desc = "[C]lose Quickfi[x] List" })
	vim.keymap.set("n", "]x", "<cmd>cnext<CR>zz", { desc = "next quickfix item" })
	vim.keymap.set("n", "[x", "<cmd>cprevious<CR>zz", { desc = "previous quickfix item" })

	-- center after navigation
	vim.keymap.set("n", "<C-d>", "<C-d>zz")
	vim.keymap.set("n", "<C-u>", "<C-u>zz")
	vim.keymap.set("n", "n", "nzzzu")
	vim.keymap.set("n", "N", "Nzzzu")

	-- external commands
	vim.keymap.set(
		"n",
		"<leader>ot",
		"<cmd>silent !tmux neww tmux-sessionizer<CR>",
		{ desc = "[O]open [T]mux Sessionizer" }
	)

	-- barbar
	vim.keymap.set("n", "<S-h>", "<cmd>BufferPrevious<cr>", { desc = "Previous buffer" })
	vim.keymap.set("n", "<S-l>", "<cmd>BufferNext<cr>", { desc = "Next buffer" })
	vim.keymap.set("n", "<leader>bd", "<cmd>BufferClose<cr>", { desc = "Close buffer" })
end

return M
