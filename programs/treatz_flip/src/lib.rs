use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer};

declare_id!("FILL_THIS_AFTER_DEPLOY"); // update post-deploy

#[program]
pub mod treatz_flip {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, fee_bps: u16, min_bet: u64, max_bet: u64) -> Result<()> {
        let g = &mut ctx.accounts.global;
        g.admin = ctx.accounts.admin.key();
        g.treatz_mint = ctx.accounts.treatz_mint.key();
        g.fee_bps = fee_bps;
        g.min_bet = min_bet;
        g.max_bet = max_bet;
        g.paused = false;
        g.treasury_ta = ctx.accounts.treasury_ta.key();
        Ok(())
    }

    /// Player places a bet. Escrow funds and record bet data. In production, this should call a VRF oracle.
    pub fn place_bet(ctx: Context<PlaceBet>, amount: u64, choice: u8) -> Result<()> {
        let g = &ctx.accounts.global;
        require!(!g.paused, ErrorCode::Paused);
        require!(choice <= 1, ErrorCode::InvalidChoice);
        require!(amount >= g.min_bet && amount <= g.max_bet, ErrorCode::BetOutOfBounds);

        let max_payout = calc_payout(amount, g.fee_bps);
        require!(ctx.accounts.treasury_ta.amount >= max_payout, ErrorCode::InsufficientTreasury);

        // Move wager into program treasury
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.player_ta.to_account_info(),
                    to: ctx.accounts.treasury_ta.to_account_info(),
                    authority: ctx.accounts.player.to_account_info(),
                },
            ),
            amount,
        )?;

        let bet = &mut ctx.accounts.bet;
        bet.player = ctx.accounts.player.key();
        bet.amount = amount;
        bet.choice = choice;
        bet.status = BetStatus::Pending as u8;
        bet.result = 255; // unknown
        bet.created_at = Clock::get()?.unix_timestamp;
        // TODO: request VRF randomness and store request id here.
        Ok(())
    }

    /// Fulfill randomness callback. Dev version accepts any caller and random bytes.
    pub fn fulfill_randomness(ctx: Context<Fulfill>, randomness: [u8; 32]) -> Result<()> {
        let bet = &mut ctx.accounts.bet;
        require!(bet.status == BetStatus::Pending as u8, ErrorCode::AlreadySettled);

        let flip = (randomness[0] & 1) as u8;
        bet.result = flip;
        bet.status = BetStatus::Settled as u8;
        bet.settled_at = Clock::get()?.unix_timestamp;

        // Treat = win when both are 1
        if flip == 1 && bet.choice == 1 {
            let p = calc_payout(bet.amount, ctx.accounts.global.fee_bps);
            // Pay from treasury to player
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.treasury_ta.to_account_info(),
                        to: ctx.accounts.player_ta.to_account_info(),
                        authority: ctx.accounts.treasury_auth.to_account_info(),
                    },
                    &[&[b"treasury_auth", &[ctx.bumps["treasury_auth"]]]],
                ),
                p,
            )?;
        }
        Ok(())
    }

    /// Admin can update config values.
    pub fn admin_update(ctx: Context<AdminUpdate>, fee_bps: u16, min_bet: u64, max_bet: u64, paused: bool) -> Result<()> {
        require_keys_eq!(ctx.accounts.global.admin, ctx.accounts.admin.key());
        let g = &mut ctx.accounts.global;
        g.fee_bps = fee_bps;
        g.min_bet = min_bet;
        g.max_bet = max_bet;
        g.paused = paused;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = 8 + GlobalState::SIZE)]
    pub global: Account<'info, GlobalState>,
    pub treatz_mint: Account<'info, Mint>,
    #[account(mut)]
    pub treasury_ta: Account<'info, TokenAccount>,
    /// CHECK: PDA authority for treasury transfers
    #[account(seeds = [b"treasury_auth"], bump)]
    pub treasury_auth: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    #[account(mut)]
    pub global: Account<'info, GlobalState>,
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut, constraint = player_ta.mint == global.treatz_mint && player_ta.owner == player.key())]
    pub player_ta: Account<'info, TokenAccount>,
    #[account(mut)]
    pub treasury_ta: Account<'info, TokenAccount>,
    #[account(init, payer = player, space = 8 + Bet::SIZE, seeds=[b"bet", player.key().as_ref(), &[Clock::get()?.unix_timestamp as u8]], bump)]
    pub bet: Account<'info, Bet>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Fulfill<'info> {
    #[account(mut)]
    pub global: Account<'info, GlobalState>,
    /// CHECK: authority to call fulfill (dev only)
    pub caller: Signer<'info>,
    #[account(mut)]
    pub bet: Account<'info, Bet>,
    #[account(mut)]
    pub treasury_ta: Account<'info, TokenAccount>,
    /// CHECK:
    #[account(seeds = [b"treasury_auth"], bump)]
    pub treasury_auth: UncheckedAccount<'info>,
    #[account(mut)]
    pub player_ta: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdminUpdate<'info> {
    #[account(mut)]
    pub global: Account<'info, GlobalState>,
    pub admin: Signer<'info>,
}

#[account]
pub struct GlobalState {
    pub admin: Pubkey,
    pub treatz_mint: Pubkey,
    pub fee_bps: u16,
    pub min_bet: u64,
    pub max_bet: u64,
    pub paused: bool,
    pub treasury_ta: Pubkey,
}
impl GlobalState {
    pub const SIZE: usize = 32 + 32 + 2 + 8 + 8 + 1 + 32;
}

#[repr(u8)]
pub enum BetStatus {
    Pending = 0,
    Settled = 1,
}

#[account]
pub struct Bet {
    pub player: Pubkey,
    pub amount: u64,
    pub choice: u8,
    pub status: u8,
    pub result: u8,
    pub created_at: i64,
    pub settled_at: i64,
}
impl Bet {
    pub const SIZE: usize = 32 + 8 + 1 + 1 + 1 + 8 + 8;
}

#[error_code]
pub enum ErrorCode {
    #[msg("Game is paused")]
    Paused,
    #[msg("Invalid choice")]
    InvalidChoice,
    #[msg("Bet out of bounds")]
    BetOutOfBounds,
    #[msg("Treasury cannot cover payout")]
    InsufficientTreasury,
    #[msg("Bet already settled")]
    AlreadySettled,
}

fn calc_payout(amount: u64, fee_bps: u16) -> u64 {
    let top: u128 = amount as u128 * (20000u128 - fee_bps as u128);
    (top / 10000u128) as u64
}
